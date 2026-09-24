//go:build linux

package main

/*
This test needs a real X server, which is why it lives behind the linux build
tag: it creates a window, drives it through the product's own action path, and
then reads the events the server actually delivered. That is what proves the
parts a pure unit test cannot: window enumeration, root-coordinate translation,
the normalized coordinate mapping, XTEST pointer motion, and XTEST button and key
delivery.

Run it on a Linux host with a display, or in a container:

	GOOS=linux GOARCH=$(uname -m) CGO_ENABLED=0 go test -c -o /tmp/driver.test .
	docker run --rm -v /tmp:/work debian:bookworm-slim sh -c \
	  "apt-get update -qq && apt-get install -y -qq xvfb x11-apps >/dev/null && \
	   Xvfb :99 -screen 0 1280x800x24 -ac & sleep 3; DISPLAY=:99 /tmp/driver.test -test.v"

Events have to be read before the same connection issues another reply-waiting
request: that wait discards events that arrive while it is pending.
*/

import (
	"encoding/base64"
	"encoding/binary"
	"image/png"
	"os"
	"strconv"
	"testing"
	"time"
)

const (
	eventButtonPress = 4
	eventKeyPress    = 2

	maskKeyPress       = 0x00000001
	maskButtonPress    = 0x00000004
	valueMaskBackPixel = 0x00000002
	valueMaskEventMask = 0x00000800
)

func createTestWindow(t *testing.T, connection *xconn, events uint32) uint32 {
	t.Helper()
	window := connection.newID()
	// depth 0 copies the parent's depth, and it is the request's second wire byte.
	body := func(w *xwriter) {
		w.u32(window)
		w.u32(connection.root)
		w.i16(120)
		w.i16(90)
		w.u16(400)
		w.u16(300)
		w.u16(0) // border width
		w.u16(1) // InputOutput
		w.u32(0)
		w.u32(valueMaskBackPixel | valueMaskEventMask)
		w.u32(0xFFFFFF)
		w.u32(events)
	}
	if err := connection.send(connection.request(1, 0, body)); err != nil {
		t.Fatalf("could not create a test window: %v", err)
	}
	if err := connection.send(connection.request(8, 0, func(w *xwriter) { w.u32(window) })); err != nil {
		t.Fatalf("could not map the test window: %v", err)
	}
	// The server processes requests in order, so a round trip is enough to know
	// the window is mapped before it is looked up again.
	time.Sleep(200 * time.Millisecond)
	return window
}

type deliveredEvent struct {
	kind   uint8
	detail uint8
	x      int
	y      int
	rootX  int
	rootY  int
}

func readEvents(t *testing.T, connection *xconn, wanted uint8, count int, timeout time.Duration) []deliveredEvent {
	t.Helper()
	var received []deliveredEvent
	deadline := time.Now().Add(timeout)
	for len(received) < count && time.Now().Before(deadline) {
		if err := connection.conn.SetReadDeadline(deadline); err != nil {
			t.Fatalf("could not set a read deadline: %v", err)
		}
		head := make([]byte, 32)
		total := 0
		for total < len(head) {
			read, err := connection.conn.Read(head[total:])
			total += read
			if err != nil {
				break
			}
		}
		if total < len(head) {
			break
		}
		switch head[0] {
		case eventButtonPress:
			if head[0] != wanted {
				continue
			}
			received = append(received, deliveredEvent{
				kind: head[0], detail: head[1],
				rootX: int(int16(binary.LittleEndian.Uint16(head[20:22]))),
				rootY: int(int16(binary.LittleEndian.Uint16(head[22:24]))),
				x:     int(int16(binary.LittleEndian.Uint16(head[24:26]))),
				y:     int(int16(binary.LittleEndian.Uint16(head[26:28]))),
			})
		case eventKeyPress:
			if head[0] != wanted {
				continue
			}
			received = append(received, deliveredEvent{kind: head[0], detail: head[1]})
		default:
			if head[0] == 35 {
				length := int(binary.LittleEndian.Uint32(head[28:32])) * 4
				if length > 0 {
					discard := make([]byte, length)
					_, _ = connection.conn.Read(discard)
				}
			}
		}
	}
	return received
}

func TestX11WindowsCaptureAndInput(t *testing.T) {
	if os.Getenv("DISPLAY") == "" {
		t.Skip("this test drives a real X server, so DISPLAY has to be set")
	}
	connection, err := dial()
	if err != nil {
		t.Fatalf("could not reach the X server: %v", err)
	}
	defer connection.conn.Close()
	window := createTestWindow(t, connection, maskButtonPress|maskKeyPress)

	records, err := connection.onScreenWindows()
	if err != nil {
		t.Fatalf("listing windows failed: %v", err)
	}
	var found *windowRecordLinux
	for index := range records {
		if records[index].window == window {
			found = &records[index]
		}
	}
	if found == nil {
		t.Fatalf("the mapped test window %d was not listed; the server reported %d windows", window, len(records))
	}
	if found.X != 120 || found.Y != 90 || found.Width != 400 || found.Height != 300 {
		t.Fatalf("the listed geometry was %d,%d %dx%d and the window was created at 120,90 400x300", found.X, found.Y, found.Width, found.Height)
	}

	// A click through the real action path: normalized coordinates in, a
	// synthesized pointer event out at the mapped position.
	args, err := parseArguments([]string{"act", "--action", "click", "--window", strconv.FormatUint(uint64(window), 10), "--x", "0.5", "--y", "0.25"})
	if err != nil {
		t.Fatalf("could not build the action arguments: %v", err)
	}
	if _, err := actResult(args); err != nil {
		t.Fatalf("the click action failed: %v", err)
	}
	// Read the event before any other reply-waiting request on this connection:
	// a reply wait discards events that arrived while it was pending.
	events := readEvents(t, connection, eventButtonPress, 1, 3*time.Second)
	if len(events) == 0 {
		t.Fatalf("the server delivered no ButtonPress event after the click")
	}
	press := events[0]
	if press.x != 200 || press.y != 75 {
		t.Fatalf("the window received the click at %d,%d and 0.5,0.25 of a 400x300 window is 200,75", press.x, press.y)
	}
	if press.rootX != 320 || press.rootY != 165 {
		t.Fatalf("the click landed at root %d,%d and the window at 120,90 makes the center 320,165", press.rootX, press.rootY)
	}
	if press.detail != 1 {
		t.Fatalf("the click used button %d, and a left click is button 1", press.detail)
	}

	// Typing goes through the keyboard mapping: 'h' has to become a real keycode.
	keyArgs, err := parseArguments([]string{"act", "--action", "type", "--window", strconv.FormatUint(uint64(window), 10), "--text", encodeForTest("hi")})
	if err != nil {
		t.Fatalf("could not build the typing arguments: %v", err)
	}
	if _, err := actResult(keyArgs); err != nil {
		t.Fatalf("the typing action failed: %v", err)
	}
	keyEvents := readEvents(t, connection, eventKeyPress, 2, 3*time.Second)
	if len(keyEvents) != 2 {
		t.Fatalf("the window received %d KeyPress events and two characters were typed", len(keyEvents))
	}
	for _, event := range keyEvents {
		if event.detail == 0 {
			t.Fatalf("a typed character produced keycode 0")
		}
	}

	// Capture writes a PNG whose size is the window's size, which is what makes
	// the returned geometry and the image agree.
	directory := t.TempDir()
	capturePath := directory + "/capture.png"
	snapshotArgs, err := parseArguments([]string{"snapshot", "--window", strconv.FormatUint(uint64(window), 10), "--out", capturePath})
	if err != nil {
		t.Fatalf("could not build the snapshot arguments: %v", err)
	}
	result, err := snapshotResult(snapshotArgs)
	if err != nil {
		t.Fatalf("the snapshot failed: %v", err)
	}
	if result["target"] != "window" {
		t.Fatalf("the snapshot reported target %v for a window capture", result["target"])
	}
	file, err := os.Open(capturePath)
	if err != nil {
		t.Fatalf("the snapshot wrote no file: %v", err)
	}
	defer file.Close()
	decoded, err := png.Decode(file)
	if err != nil {
		t.Fatalf("the snapshot was not a readable PNG: %v", err)
	}
	if decoded.Bounds().Dx() != 400 || decoded.Bounds().Dy() != 300 {
		t.Fatalf("the capture is %dx%d and the window is 400x300", decoded.Bounds().Dx(), decoded.Bounds().Dy())
	}
}

func encodeForTest(value string) string {
	return base64.StdEncoding.EncodeToString([]byte(value))
}
