//go:build linux

package main

import (
	"encoding/binary"
	"fmt"
	"image"
	"image/png"
	"math/bits"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

/*
The Linux implementation speaks X11 directly, with no cgo and no dependency on
xdotool, ImageMagick, or any toolkit being installed: the release machine builds
this binary for Linux from macOS, so everything it needs has to be in Go.

Screen capture uses GetImage on the root window over the target rectangle, and
input uses the XTEST extension's FakeInput request (type, detail, delay, root,
rootX, rootY as specified by the XTEST protocol). XTEST events are what the
server treats as real input, which is the whole point: a core-protocol
SendEvent would be ignored by most toolkits.

Wayland is reported as unsupported rather than half-supported. There the
compositor forbids direct capture and input synthesis; a client has to ask
xdg-desktop-portal for a RemoteDesktop session and take screen content through
ScreenCast/PipeWire, with the person approving a dialog. Shun does not do that
yet, and says so instead of failing obscurely.
*/

const (
	imageZPixmap = 2

	requestInternAtom      = 16
	requestGetWindowAttr   = 3
	requestConfigureWindow = 12
	requestGetGeometry     = 14
	requestQueryTree       = 15
	requestGetProperty     = 20
	requestSetInputFocus   = 42
	requestQueryPointer    = 38
	requestGetImage        = 73
	requestQueryExtension  = 98
	requestGetKeyboardMap  = 101
	requestGetInputFocus   = 43

	configureStackMode = 0x0040
	stackModeAbove     = 0

	atomWindow = 33
)

type xconn struct {
	conn net.Conn

	resourceBase uint32
	resourceMask uint32

	root       uint32
	rootWidth  int
	rootHeight int
	rootDepth  uint8

	redMask   uint32
	greenMask uint32
	blueMask  uint32
	bpp       uint8

	byteOrder      byte
	imageByteOrder byte
	scanlinePad    int

	minKeycode uint8
	maxKeycode uint8

	sequence uint16

	xtestOpcode byte
	saver       *saverExtension

	keymap map[uint32]xkey
}

type xkey struct {
	code  uint8
	shift bool
}

type saverExtension struct {
	opcode byte
	usable bool
}

func failMessage(format string, values ...any) error { return fmt.Errorf(format, values...) }

func displayName() (string, error) {
	display := strings.TrimSpace(os.Getenv("DISPLAY"))
	if display == "" {
		if strings.TrimSpace(os.Getenv("WAYLAND_DISPLAY")) != "" {
			return "", failMessage("this is a Wayland session, and Shun does not capture or control Wayland desktops yet: the compositor requires an xdg-desktop-portal RemoteDesktop session with screen access approved in a dialog each time. Log in to an X11 session, or run the application Shun should act on where it can be driven directly")
		}
		return "", failMessage("no X display is available: DISPLAY is not set in this session")
	}
	return display, nil
}

func parseDisplay(display string) (host string, number int, err error) {
	value := display
	if index := strings.IndexByte(value, ':'); index >= 0 {
		host = value[:index]
		value = value[index+1:]
	} else {
		return "", 0, failMessage("DISPLAY (%s) is not in host:display form", display)
	}
	if index := strings.IndexByte(value, '.'); index >= 0 {
		value = value[:index]
	}
	parsed := 0
	for _, character := range value {
		if character < '0' || character > '9' {
			return "", 0, failMessage("DISPLAY (%s) does not name a display number", display)
		}
		parsed = parsed*10 + int(character-'0')
	}
	return host, parsed, nil
}

func connect(host string, number int) (net.Conn, error) {
	if host == "" || host == "unix" {
		path := filepath.Join("/tmp/.X11-unix", fmt.Sprintf("X%d", number))
		conn, err := net.DialTimeout("unix", path, 5*time.Second)
		if err == nil {
			return conn, nil
		}
		if strings.TrimSpace(os.Getenv("WAYLAND_DISPLAY")) != "" {
			return nil, failMessage("this session exposes no X display socket at %s and reports Wayland; Shun does not capture or control Wayland desktops yet", path)
		}
		return nil, failMessage("no X server is listening at %s: %v", path, err)
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, 6000+number), 5*time.Second)
	if err != nil {
		return nil, failMessage("no X server answered at %s: %d: %v", host, 6000+number, err)
	}
	return conn, nil
}

// xauthorityEntry returns the MIT-MAGIC-COOKIE-1 value for a display, which is
// what a real desktop requires; an unauthenticated X server simply gets nothing.
func xauthorityEntry(host string, number int, local bool) (string, []byte) {
	path := strings.TrimSpace(os.Getenv("XAUTHORITY"))
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", nil
		}
		path = filepath.Join(home, ".Xauthority")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil
	}
	hostname, _ := os.Hostname()
	offset := 0
	for offset+8 <= len(data) {
		family := binary.BigEndian.Uint16(data[offset:])
		offset += 2
		address, ok := readXauString(data, &offset)
		if !ok {
			return "", nil
		}
		display, ok := readXauString(data, &offset)
		if !ok {
			return "", nil
		}
		name, ok := readXauString(data, &offset)
		if !ok {
			return "", nil
		}
		value, ok := readXauString(data, &offset)
		if !ok {
			return "", nil
		}
		if name != "MIT-MAGIC-COOKIE-1" {
			continue
		}
		if display != fmt.Sprintf("%d", number) {
			continue
		}
		switch family {
		case 256: // FamilyLocal
			if local && (address == hostname || address == "") {
				return name, []byte(value)
			}
		case 0: // FamilyInternet
			if !local && strings.EqualFold(address, host) {
				return name, []byte(value)
			}
		case 65535: // FamilyWild
			return name, []byte(value)
		}
	}
	return "", nil
}

func readXauString(data []byte, offset *int) (string, bool) {
	if *offset+2 > len(data) {
		return "", false
	}
	length := int(binary.BigEndian.Uint16(data[*offset:]))
	*offset += 2
	if *offset+length > len(data) {
		return "", false
	}
	value := string(data[*offset : *offset+length])
	*offset += length
	return value, true
}

func dial() (*xconn, error) {
	display, err := displayName()
	if err != nil {
		return nil, err
	}
	host, number, err := parseDisplay(display)
	if err != nil {
		return nil, err
	}
	local := host == "" || host == "unix"
	conn, err := connect(host, number)
	if err != nil {
		return nil, err
	}
	name, cookie := xauthorityEntry(host, number, local)

	direct := name == "MIT-MAGIC-COOKIE-1"
	var authName, authData []byte
	if direct {
		authName = []byte(name)
		authData = cookie
	}
	// Connection setup: byte order, pad, protocol major/minor, then the two
	// 16-bit lengths of the authorization name and data, each CARD16.
	setup := &xwriter{}
	setup.u8('l')
	setup.u8(0)
	setup.u16(11)
	setup.u16(0)
	setup.u16(uint16(len(authName)))
	setup.u16(uint16(len(authData)))
	setup.pad(2)
	setup.bytes = appendPadded(setup.bytes, authName)
	setup.bytes = appendPadded(setup.bytes, authData)
	if err := conn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return nil, err
	}
	if _, err := conn.Write(setup.bytes); err != nil {
		return nil, failMessage("the X server closed the connection while Shun was connecting: %v", err)
	}

	head := make([]byte, 8)
	if _, err := readFull(conn, head); err != nil {
		return nil, failMessage("the X server did not answer the connection setup: %v", err)
	}
	status := head[0]
	length := int(binary.LittleEndian.Uint16(head[6:8])) * 4
	payload := make([]byte, length)
	if _, err := readFull(conn, payload); err != nil {
		return nil, failMessage("the X connection setup was cut short: %v", err)
	}
	if status != 1 {
		reason := strings.TrimRight(string(payload), "\x00")
		if reason == "" {
			reason = "the server refused the connection"
		}
		return nil, failMessage("the X server refused this connection: %s", reason)
	}
	connection, err := parseSetup(payload)
	if err != nil {
		return nil, err
	}
	connection.conn = conn
	// The handshake is over, so later operations set their own deadlines.
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}

	opcode, present, err := connection.queryExtension("XTEST")
	if err != nil {
		conn.Close()
		return nil, err
	}
	if !present {
		conn.Close()
		return nil, failMessage("this X server does not offer the XTEST extension, so Shun cannot synthesize input for it")
	}
	connection.xtestOpcode = opcode

	if opcode, present, err := connection.queryExtension("MIT-SCREEN-SAVER"); err == nil && present {
		connection.saver = &saverExtension{opcode: opcode, usable: true}
	}

	if err := connection.loadKeymap(); err != nil {
		conn.Close()
		return nil, err
	}
	return connection, nil
}

func appendPadded(target []byte, value []byte) []byte {
	target = append(target, value...)
	for len(target)%4 != 0 {
		target = append(target, 0)
	}
	return target
}

func readFull(conn net.Conn, buffer []byte) (int, error) {
	total := 0
	for total < len(buffer) {
		read, err := conn.Read(buffer[total:])
		total += read
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func parseSetup(payload []byte) (*xconn, error) {
	if len(payload) < 32 {
		return nil, failMessage("the X connection setup was shorter than the protocol allows")
	}
	connection := &xconn{byteOrder: 'l'}
	connection.resourceBase = binary.LittleEndian.Uint32(payload[4:8])
	connection.resourceMask = binary.LittleEndian.Uint32(payload[8:12])
	vendorLength := int(binary.LittleEndian.Uint16(payload[16:18]))
	screenCount := int(payload[20])
	formatCount := int(payload[21])
	connection.imageByteOrder = payload[22]
	connection.minKeycode = payload[26]
	connection.maxKeycode = payload[27]
	if screenCount < 1 {
		return nil, failMessage("the X server reported no screens")
	}
	offset := 32 + ((vendorLength + 3) / 4 * 4)
	// Each pixmap format is a depth plus the bits per pixel the server uses for
	// it: a 24-bit root depth is a 32-bit pixel, which is what sizes the capture.
	formats := map[uint8]struct {
		bitsPerPixel int
		scanlinePad  int
	}{}
	for index := 0; index < formatCount; index++ {
		if offset+8 > len(payload) {
			break
		}
		depth := payload[offset]
		bitsPerPixel := int(payload[offset+1])
		padBits := int(payload[offset+2])
		if padBits <= 0 {
			padBits = 32
		}
		formats[depth] = struct {
			bitsPerPixel int
			scanlinePad  int
		}{bitsPerPixel, padBits / 8}
		offset += 8
	}
	if offset+40 > len(payload) {
		return nil, failMessage("the X connection setup ended before the first screen")
	}
	connection.root = binary.LittleEndian.Uint32(payload[offset : offset+4])
	connection.rootWidth = int(binary.LittleEndian.Uint16(payload[offset+20 : offset+22]))
	connection.rootHeight = int(binary.LittleEndian.Uint16(payload[offset+22 : offset+24]))
	rootVisual := binary.LittleEndian.Uint32(payload[offset+32 : offset+36])
	connection.rootDepth = payload[offset+38]
	format, ok := formats[connection.rootDepth]
	if !ok {
		return nil, failMessage("the X server did not describe a pixel format for the root depth %d", connection.rootDepth)
	}
	connection.bpp = uint8(format.bitsPerPixel)
	connection.scanlinePad = format.scanlinePad
	depthCount := int(payload[offset+39])
	offset += 40
	for depth := 0; depth < depthCount; depth++ {
		if offset+8 > len(payload) {
			return nil, failMessage("the X connection setup ended inside the screen description")
		}
		visualCount := int(binary.LittleEndian.Uint16(payload[offset+2 : offset+4]))
		offset += 8
		for visual := 0; visual < visualCount; visual++ {
			if offset+24 > len(payload) {
				return nil, failMessage("the X connection setup ended inside a visual")
			}
			id := binary.LittleEndian.Uint32(payload[offset : offset+4])
			if id == rootVisual {
				connection.redMask = binary.LittleEndian.Uint32(payload[offset+8 : offset+12])
				connection.greenMask = binary.LittleEndian.Uint32(payload[offset+12 : offset+16])
				connection.blueMask = binary.LittleEndian.Uint32(payload[offset+16 : offset+20])
			}
			offset += 24
		}
	}
	if connection.redMask == 0 && connection.greenMask == 0 && connection.blueMask == 0 {
		return nil, failMessage("the X server did not describe the root visual's colour masks")
	}
	connection.keymap = map[uint32]xkey{}
	return connection, nil
}

func (c *xconn) newID() uint32 {
	// Resource ids have to stay inside the client's own range: the base carries
	// the bits of the mask, and every id this client makes must keep them.
	c.resourceBase = (c.resourceBase + 1) | (c.resourceBase & ^c.resourceMask)
	return c.resourceBase
}

// request builds one X request. The second wire byte is a field for some
// requests (CreateWindow's depth, InternAtom's only-if-exists, GetImage's
// format, SetInputFocus's revert-to) and padding for the rest, so it is passed
// explicitly: a request whose first field sits before the length cannot be built
// by appending to a fixed header.
func (c *xconn) request(opcode byte, first byte, body func(*xwriter)) *xwriter {
	writer := &xwriter{}
	writer.bytes = make([]byte, 4)
	writer.bytes[0] = opcode
	writer.bytes[1] = first
	if body != nil {
		body(writer)
	}
	for len(writer.bytes)%4 != 0 {
		writer.bytes = append(writer.bytes, 0)
	}
	binary.LittleEndian.PutUint16(writer.bytes[2:4], uint16(len(writer.bytes)/4))
	c.sequence++
	return writer
}

func (c *xconn) send(writer *xwriter) error {
	_, err := c.conn.Write(writer.bytes)
	if err != nil {
		return failMessage("the X server connection was lost: %v", err)
	}
	return nil
}

func (c *xconn) sendWait(writer *xwriter) ([]byte, error) {
	sequence := c.sequence
	if err := c.send(writer); err != nil {
		return nil, err
	}
	return c.waitReply(sequence)
}

func (c *xconn) waitReply(sequence uint16) ([]byte, error) {
	for {
		head := make([]byte, 32)
		if err := c.conn.SetReadDeadline(time.Now().Add(20 * time.Second)); err != nil {
			return nil, err
		}
		if _, err := readFull(c.conn, head); err != nil {
			return nil, failMessage("the X server stopped answering: %v", err)
		}
		switch head[0] {
		case 0: // error
			return nil, decodeError(head)
		case 1: // reply
			if got := binary.LittleEndian.Uint16(head[2:4]); got != sequence {
				return nil, failMessage("the X server answered request %d when %d was expected", got, sequence)
			}
			length := int(binary.LittleEndian.Uint32(head[4:8])) * 4
			if length == 0 {
				return head, nil
			}
			extra := make([]byte, length)
			if _, err := readFull(c.conn, extra); err != nil {
				return nil, failMessage("an X reply was cut short: %v", err)
			}
			return append(head, extra...), nil
		default:
			// An event arrived before the reply, and this path discards it: the
			// driver asks for replies only while setting up, and never while an
			// event it cares about is expected. A caller that wants events has to
			// read them before it issues another reply-waiting request on the same
			// connection, or this loop will consume them.

			if head[0] == 35 {
				length := int(binary.LittleEndian.Uint32(head[28:32])) * 4
				if length > 0 {
					discard := make([]byte, length)
					if _, err := readFull(c.conn, discard); err != nil {
						return nil, failMessage("an X event was cut short: %v", err)
					}
				}
			}
		}
	}
}

func decodeError(head []byte) error {
	code := head[1]
	detail := binary.LittleEndian.Uint32(head[4:8])
	names := map[byte]string{1: "request", 2: "value", 3: "window", 4: "pixmap", 5: "atom", 6: "cursor", 7: "font", 8: "match", 9: "drawable", 10: "access", 11: "alloc", 12: "colormap", 13: "gcontext", 14: "id-choice", 16: "length", 17: "implementation"}
	name := names[code]
	if name == "" {
		name = fmt.Sprintf("code %d", code)
	}
	return failMessage("the X server rejected a %s request (opcode %d, detail %d, sequence %d)", name, head[10], detail, binary.LittleEndian.Uint16(head[2:4]))
}

type xwriter struct {
	bytes []byte
}

func (w *xwriter) u8(value uint8)   { w.bytes = append(w.bytes, value) }
func (w *xwriter) u16(value uint16) { w.bytes = binary.LittleEndian.AppendUint16(w.bytes, value) }
func (w *xwriter) u32(value uint32) { w.bytes = binary.LittleEndian.AppendUint32(w.bytes, value) }
func (w *xwriter) i16(value int16)  { w.u16(uint16(value)) }
func (w *xwriter) pad(count int)    { w.bytes = append(w.bytes, make([]byte, count)...) }
func (w *xwriter) name(value string) {
	w.u16(uint16(len(value)))
	w.pad(2)
	w.bytes = appendPadded(w.bytes, []byte(value))
}

func u16at(data []byte, offset int) uint16 {
	return binary.LittleEndian.Uint16(data[offset : offset+2])
}
func u32at(data []byte, offset int) uint32 {
	return binary.LittleEndian.Uint32(data[offset : offset+4])
}
func i16at(data []byte, offset int) int {
	return int(int16(binary.LittleEndian.Uint16(data[offset : offset+2])))
}

func (c *xconn) internAtom(name string, onlyIfExists bool) (uint32, error) {
	flag := byte(0)
	if onlyIfExists {
		flag = 1
	}
	reply, err := c.sendWait(c.request(requestInternAtom, flag, func(w *xwriter) { w.name(name) }))
	if err != nil {
		return 0, err
	}
	return u32at(reply, 8), nil
}

func (c *xconn) queryExtension(name string) (byte, bool, error) {
	reply, err := c.sendWait(c.request(requestQueryExtension, 0, func(w *xwriter) { w.name(name) }))
	if err != nil {
		return 0, false, err
	}
	if reply[8] == 0 {
		return 0, false, nil
	}
	return reply[9], true, nil
}

type windowAttributes struct {
	visual           uint32
	class            uint8
	mapState         uint8
	overrideRedirect bool
}

func (c *xconn) windowAttributes(window uint32) (windowAttributes, error) {
	reply, err := c.sendWait(c.request(requestGetWindowAttr, 0, func(w *xwriter) { w.u32(window) }))
	if err != nil {
		return windowAttributes{}, err
	}
	return windowAttributes{
		visual:           u32at(reply, 8),
		class:            reply[12],
		mapState:         reply[26],
		overrideRedirect: reply[27] == 1,
	}, nil
}

func (c *xconn) queryTree(window uint32) ([]uint32, error) {
	reply, err := c.sendWait(c.request(requestQueryTree, 0, func(w *xwriter) { w.u32(window) }))
	if err != nil {
		return nil, err
	}
	count := int(u16at(reply, 16))
	children := make([]uint32, 0, count)
	for index := 0; index < count; index++ {
		offset := 32 + index*4
		if offset+4 > len(reply) {
			break
		}
		children = append(children, u32at(reply, offset))
	}
	return children, nil
}

func (c *xconn) geometry(window uint32) (int, int, int, int, error) {
	reply, err := c.sendWait(c.request(requestGetGeometry, 0, func(w *xwriter) { w.u32(window) }))
	if err != nil {
		return 0, 0, 0, 0, err
	}
	return i16at(reply, 12), i16at(reply, 14), int(u16at(reply, 16)), int(u16at(reply, 18)), nil
}

func (c *xconn) translate(window uint32, root uint32) (int, int, error) {
	reply, err := c.sendWait(c.request(40, 0, func(w *xwriter) {
		w.u32(window)
		w.u32(root)
		w.i16(0)
		w.i16(0)
	}))
	if err != nil {
		return 0, 0, err
	}
	return i16at(reply, 12), i16at(reply, 14), nil
}

func (c *xconn) property(window uint32, property uint32, propertyType uint32) (uint32, []byte, error) {
	reply, err := c.sendWait(c.request(requestGetProperty, 0, func(w *xwriter) {
		w.u32(window)
		w.u32(property)
		w.u32(propertyType)
		w.u32(0)
		w.u32(4096)
	}))
	if err != nil {
		return 0, nil, err
	}
	format := reply[1]
	actualType := u32at(reply, 8)
	count := int(u32at(reply, 16))
	value := reply[32:]
	switch format {
	case 8:
		if count > len(value) {
			count = len(value)
		}
		return actualType, value[:count], nil
	case 16:
		if count*2 > len(value) {
			count = len(value) / 2
		}
		out := make([]byte, 0, count*2)
		for index := 0; index < count; index++ {
			out = binary.LittleEndian.AppendUint16(out, u16at(value, index*2))
		}
		return actualType, out, nil
	default:
		length := count * 4
		if length > len(value) {
			length = len(value)
		}
		return actualType, value[:length], nil
	}
}

func (c *xconn) setInputFocus(window uint32) error {
	return c.send(c.request(requestSetInputFocus, 2, func(w *xwriter) { // RevertToParent
		w.u32(window)
		w.u32(0) // CurrentTime
	}))
}

func (c *xconn) raise(window uint32) error {
	return c.send(c.request(requestConfigureWindow, 0, func(w *xwriter) {
		w.u32(window)
		w.u16(configureStackMode)
		w.pad(2)
		w.u32(stackModeAbove)
	}))
}

// sync forces a round trip. Every synthesized event has to be processed by the
// server before this driver exits: a client that disconnects while its last
// request is still in flight has not performed the action it reported, and on a
// real desktop that is a click that silently never happened.
func (c *xconn) sync() error {
	_, err := c.sendWait(c.request(requestGetInputFocus, 0, nil))
	return err
}

func (c *xconn) queryPointer() (int, int, uint32, error) {
	reply, err := c.sendWait(c.request(requestQueryPointer, 0, func(w *xwriter) { w.u32(c.root) }))
	if err != nil {
		return 0, 0, 0, err
	}
	return i16at(reply, 16), i16at(reply, 18), u32at(reply, 12), nil
}

func (c *xconn) loadKeymap() error {
	count := int(c.maxKeycode) - int(c.minKeycode) + 1
	if count <= 0 {
		return failMessage("the X server reported an empty keyboard mapping")
	}
	reply, err := c.sendWait(c.request(requestGetKeyboardMap, 0, func(w *xwriter) {
		w.u8(c.minKeycode)
		w.u8(uint8(count))
		w.pad(2)
	}))
	if err != nil {
		return err
	}
	perCode := int(reply[1])
	if perCode < 1 {
		return failMessage("the X server reported an empty keyboard mapping")
	}
	for index := 0; index < count*perCode; index++ {
		offset := 32 + index*4
		if offset+4 > len(reply) {
			break
		}
		keysym := u32at(reply, offset)
		if keysym == 0 {
			continue
		}
		code := uint8(int(c.minKeycode) + index/perCode)
		shift := perCode > 1 && index%perCode == 1
		if _, exists := c.keymap[keysym]; exists {
			continue
		}
		c.keymap[keysym] = xkey{code: code, shift: shift}
	}
	return nil
}

var keysyms = map[string]uint32{
	"return": 0xFF0D, "enter": 0xFF8D, "tab": 0xFF09, "space": 0x0020,
	"delete": 0xFF08, "forward_delete": 0xFFFF, "escape": 0xFF1B,
	"left": 0xFF51, "up": 0xFF52, "right": 0xFF53, "down": 0xFF54,
	"home": 0xFF50, "end": 0xFF57, "page_up": 0xFF55, "page_down": 0xFF56,
}

var modifierKeysyms = map[string]uint32{"cmd": 0xFFEB, "command": 0xFFEB, "meta": 0xFFEB, "shift": 0xFFE1, "alt": 0xFFE9, "option": 0xFFE9, "ctrl": 0xFFE3, "control": 0xFFE3}

func keysymFor(character rune) uint32 {
	if character < 0x100 {
		return uint32(character)
	}
	return 0x01000000 | uint32(character)
}

// fakeInput sends one XTEST event. The field order and the rootX/rootY position
// at offset 24 come from the XTEST protocol's FakeInput encoding.
func (c *xconn) fakeInput(eventType uint8, detail uint8, root uint32, x int, y int) error {
	body := make([]byte, 36)
	body[0] = c.xtestOpcode
	body[1] = 2
	binary.LittleEndian.PutUint16(body[2:4], 9)
	body[4] = eventType
	body[5] = detail
	binary.LittleEndian.PutUint32(body[8:12], 0)
	binary.LittleEndian.PutUint32(body[12:16], root)
	binary.LittleEndian.PutUint16(body[24:26], uint16(int16(x)))
	binary.LittleEndian.PutUint16(body[26:28], uint16(int16(y)))
	c.sequence++
	if _, err := c.conn.Write(body); err != nil {
		return failMessage("the X server connection was lost: %v", err)
	}
	// XTEST has no reply, so any protocol error surfaces on the next request.
	return nil
}

func (c *xconn) keyEvent(keysym uint32, pressed bool) error {
	key, ok := c.keymap[keysym]
	if !ok {
		return failMessage("this keyboard layout has no key for that character; switch layout or use text the layout can produce")
	}
	if key.shift {
		shift, ok := c.keymap[modifierKeysyms["shift"]]
		if !ok {
			return failMessage("this keyboard layout has no Shift key, so that character cannot be typed")
		}
		eventType := uint8(2)
		if !pressed {
			eventType = 3
		}
		if err := c.fakeInput(eventType, shift.code, 0, 0, 0); err != nil {
			return err
		}
	}
	eventType := uint8(2)
	if !pressed {
		eventType = 3
	}
	return c.fakeInput(eventType, key.code, 0, 0, 0)
}

func (c *xconn) tapKeysym(keysym uint32) error {
	if err := c.keyEvent(keysym, true); err != nil {
		return err
	}
	return c.keyEvent(keysym, false)
}

func (c *xconn) pointerTo(x int, y int) error {
	// A motion to the coordinates the pointer already holds is a no-op for the
	// server, and the window under the pointer would then still be the one from
	// before the target was raised. One pixel away and back makes the motion real.
	if currentX, currentY, _, err := c.queryPointer(); err == nil && currentX == x && currentY == y {
		if err := c.fakeInput(6, 0, c.root, x+1, y); err != nil {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
	// detail 0 means the coordinates are absolute.
	return c.fakeInput(6, 0, c.root, x, y)
}

func (c *xconn) button(button uint8, pressed bool) error {
	eventType := uint8(5)
	if pressed {
		eventType = 4
	}
	return c.fakeInput(eventType, button, 0, 0, 0)
}

func (c *xconn) capture(rect geometry) (*image.RGBA, error) {
	if rect.Width <= 0 || rect.Height <= 0 {
		return nil, failMessage("there is nothing to capture in that region")
	}
	reply, err := c.sendWait(c.request(requestGetImage, imageZPixmap, func(w *xwriter) {
		w.u32(c.root)
		w.i16(int16(rect.X))
		w.i16(int16(rect.Y))
		w.u16(uint16(rect.Width))
		w.u16(uint16(rect.Height))
		w.u32(0xFFFFFFFF)
	}))
	if err != nil {
		return nil, err
	}
	depth := reply[1]
	_ = depth
	data := reply[32:]
	bytesPerPixel := int(c.bpp) / 8
	if bytesPerPixel < 1 {
		return nil, failMessage("the X server reported an unusable root visual depth (%d bpp)", c.bpp)
	}
	stride := ((rect.Width*int(c.bpp) + c.scanlinePad*8 - 1) / (c.scanlinePad * 8)) * c.scanlinePad
	if len(data) < stride*rect.Height {
		return nil, failMessage("the X server returned %d bytes for a %dx%d capture", len(data), rect.Width, rect.Height)
	}
	out := image.NewRGBA(image.Rect(0, 0, rect.Width, rect.Height))
	littleEndian := c.imageByteOrder == 0
	for y := 0; y < rect.Height; y++ {
		row := data[y*stride:]
		destination := out.Pix[y*out.Stride:]
		for x := 0; x < rect.Width; x++ {
			offset := x * bytesPerPixel
			var pixel uint32
			switch bytesPerPixel {
			case 4:
				if littleEndian {
					pixel = binary.LittleEndian.Uint32(row[offset : offset+4])
				} else {
					pixel = binary.BigEndian.Uint32(row[offset : offset+4])
				}
			case 3:
				if littleEndian {
					pixel = uint32(row[offset]) | uint32(row[offset+1])<<8 | uint32(row[offset+2])<<16
				} else {
					pixel = uint32(row[offset])<<16 | uint32(row[offset+1])<<8 | uint32(row[offset+2])
				}
			default:
				if littleEndian {
					pixel = uint32(binary.LittleEndian.Uint16(row[offset : offset+2]))
				} else {
					pixel = uint32(binary.BigEndian.Uint16(row[offset : offset+2]))
				}
			}
			destination[x*4] = channel(pixel, c.redMask)
			destination[x*4+1] = channel(pixel, c.greenMask)
			destination[x*4+2] = channel(pixel, c.blueMask)
			destination[x*4+3] = 255
		}
	}
	return out, nil
}

func channel(pixel uint32, mask uint32) uint8 {
	if mask == 0 {
		return 0
	}
	shift := bits.TrailingZeros32(mask)
	value := (pixel & mask) >> shift
	maximum := mask >> shift
	return uint8(value * 255 / maximum)
}

func writePNG(captured image.Image, path string) error {
	file, err := os.Create(path)
	if err != nil {
		return failMessage("could not write the capture: %v", err)
	}
	defer file.Close()
	if err := png.Encode(file, captured); err != nil {
		return failMessage("could not encode the capture as PNG: %v", err)
	}
	return nil
}

type windowRecordLinux struct {
	windowRecord
	window uint32
}

func (c *xconn) clientName(window uint32) (string, string) {
	title := strings.TrimSpace(c.propertyText(window, "_NET_WM_NAME"))
	if title == "" {
		title = strings.TrimSpace(c.propertyText(window, "WM_NAME"))
	}
	app := ""
	if class := c.propertyText(window, "WM_CLASS"); class != "" {
		parts := strings.Split(class, "\x00")
		for index := len(parts) - 1; index >= 0; index-- {
			if strings.TrimSpace(parts[index]) != "" {
				app = strings.TrimSpace(parts[index])
				break
			}
		}
	}
	if title != "" || app != "" {
		return app, title
	}
	// A reparenting window manager puts the frame on the root, and the client is
	// its child, which is where the name and class actually live.
	children, err := c.queryTree(window)
	if err != nil {
		return "", ""
	}
	for _, child := range children {
		childApp, childTitle := c.clientName(child)
		if childTitle != "" || childApp != "" {
			return childApp, childTitle
		}
	}
	return "", ""
}

func (c *xconn) propertyText(window uint32, name string) string {
	atom, err := c.internAtom(name, true)
	if err != nil || atom == 0 {
		return ""
	}
	_, value, err := c.property(window, atom, 0)
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(value), "\x00")
}

func (c *xconn) onScreenWindows() ([]windowRecordLinux, error) {
	children, err := c.queryTree(c.root)
	if err != nil {
		return nil, err
	}
	var records []windowRecordLinux
	for _, child := range children {
		attributes, err := c.windowAttributes(child)
		if err != nil {
			continue
		}
		if attributes.mapState != 2 || attributes.overrideRedirect || attributes.class != 1 {
			continue
		}
		x, y, err := c.translate(child, c.root)
		if err != nil {
			continue
		}
		_, _, width, height, err := c.geometry(child)
		if err != nil || width < minimumWindowSize || height < minimumWindowSize {
			continue
		}
		app, title := c.clientName(child)
		records = append(records, windowRecordLinux{
			windowRecord: windowRecord{
				ID: int(child), PID: 0, App: boundedText(app, 120), Title: boundedText(title, 300), Layer: 0,
				X: x, Y: y, Width: width, Height: height,
			},
			window: child,
		})
	}
	return records, nil
}

func (c *xconn) focusRecord(record windowRecordLinux) error {
	if err := c.raise(record.window); err != nil {
		return err
	}
	return c.setInputFocus(record.window)
}

func resolveLinux(records []windowRecordLinux, selector string) (windowRecordLinux, error) {
	if len(records) == 0 {
		return windowRecordLinux{}, failMessage("no on-screen window is available to act on")
	}
	selector = strings.TrimSpace(selector)
	if selector == "" || strings.EqualFold(selector, "frontmost") {
		return records[0], nil
	}
	if id, err := parseWindowID(selector); err == nil {
		for _, record := range records {
			if record.ID == id {
				return record, nil
			}
		}
		return windowRecordLinux{}, failMessage("no on-screen window has id %d; list windows again and use a current id", id)
	}
	var matches []windowRecordLinux
	for _, record := range records {
		if strings.EqualFold(record.App, selector) || strings.EqualFold(record.Title, selector) {
			matches = append(matches, record)
		}
	}
	if len(matches) > 1 {
		return windowRecordLinux{}, failMessage("more than one window matches %s; use an exact window id from the window list", selector)
	}
	if len(matches) == 0 {
		return windowRecordLinux{}, failMessage("no on-screen window matches %s; list windows again and use an exact id", selector)
	}
	return matches[0], nil
}

func probeResult() (map[string]any, error) {
	connection, err := dial()
	if err != nil {
		return nil, err
	}
	defer connection.conn.Close()
	records, err := connection.onScreenWindows()
	if err != nil {
		return nil, err
	}
	records = connection.withFrontmost(records)
	frontmost := ""
	if len(records) > 0 {
		frontmost = records[0].App
		if frontmost == "" {
			frontmost = records[0].Title
		}
	}
	return map[string]any{
		"ok":               true,
		"accessibility":    true,
		"screen_recording": true,
		"user_idle_ms":     connection.userIdleMilliseconds(),
		"capture": map[string]any{
			"supported": true,
			"displays":  1,
			"windows":   len(records),
		},
		"display":             geometry{X: 0, Y: 0, Width: connection.rootWidth, Height: connection.rootHeight}.json(),
		"frontmost":           frontmost,
		"frontmost_bundle_id": "",
		"session":             "x11",
	}, nil
}

func windowsResult() (map[string]any, error) {
	connection, err := dial()
	if err != nil {
		return nil, err
	}
	defer connection.conn.Close()
	records, err := connection.onScreenWindows()
	if err != nil {
		return nil, err
	}
	rows := make([]map[string]any, 0, len(records))
	for _, record := range records {
		rows = append(rows, record.json())
	}
	frontmost := map[string]any{"app": "", "pid": 0, "bundle_id": ""}
	if len(records) > 0 {
		frontmost = map[string]any{"app": records[0].App, "pid": 0, "bundle_id": ""}
	}
	return map[string]any{
		"ok":        true,
		"frontmost": frontmost,
		"display":   geometry{X: 0, Y: 0, Width: connection.rootWidth, Height: connection.rootHeight}.json(),
		"windows":   rows,
		"session":   "x11",
	}, nil
}

func snapshotResult(a arguments) (map[string]any, error) {
	target := strings.TrimSpace(a.text("window"))
	if target == "" {
		target = "frontmost"
	}
	out, err := a.required("out")
	if err != nil {
		return nil, err
	}
	connection, err := dial()
	if err != nil {
		return nil, err
	}
	defer connection.conn.Close()
	rect := geometry{X: 0, Y: 0, Width: connection.rootWidth, Height: connection.rootHeight}
	result := map[string]any{
		"ok":      true,
		"target":  "screen",
		"method":  "screen_copy",
		"display": rect.json(),
		"bounds":  rect.json(),
		"session": "x11",
	}
	if target != "screen" {
		records, err := connection.onScreenWindows()
		if err != nil {
			return nil, err
		}
		record, err := resolveLinux(records, target)
		if err != nil {
			return nil, err
		}
		rect = record.geometry()
		result["target"] = "window"
		result["window"] = record.json()
		result["bounds"] = rect.json()
	}
	captured, err := connection.capture(rect)
	if err != nil {
		return nil, err
	}
	if err := writePNG(captured, out); err != nil {
		return nil, err
	}
	return result, nil
}

func actResult(a arguments) (map[string]any, error) {
	action, err := a.required("action")
	if err != nil {
		return nil, err
	}
	connection, err := dial()
	if err != nil {
		return nil, err
	}
	defer connection.conn.Close()

	records, err := connection.onScreenWindows()
	if err != nil {
		return nil, err
	}
	records = connection.withFrontmost(records)
	selector := strings.TrimSpace(a.text("window"))
	var record windowRecordLinux
	needsWindow := action != "key" && action != "scroll"
	if needsWindow {
		record, err = resolveLinux(records, selector)
		if err != nil {
			return nil, err
		}
		if err := connection.focusRecord(record); err != nil {
			return nil, err
		}
		time.Sleep(150 * time.Millisecond)
	}
	bounds := geometry{X: 0, Y: 0, Width: connection.rootWidth, Height: connection.rootHeight}
	if needsWindow {
		bounds = record.geometry()
	}

	switch action {
	case "click", "double_click", "right_click":
		x, err := a.normalized("x")
		if err != nil {
			return nil, err
		}
		y, err := a.normalized("y")
		if err != nil {
			return nil, err
		}
		px, py := bounds.point(x, y)
		if err := connection.pointerTo(px, py); err != nil {
			return nil, err
		}
		time.Sleep(40 * time.Millisecond)
		if err := connection.verifyPointerTarget(record); err != nil {
			return nil, err
		}
		button := uint8(1)
		if action == "right_click" {
			button = 3
		}
		presses := 1
		if action == "double_click" {
			presses = 2
		}
		for index := 0; index < presses; index++ {
			if err := connection.button(button, true); err != nil {
				return nil, err
			}
			time.Sleep(40 * time.Millisecond)
			if err := connection.button(button, false); err != nil {
				return nil, err
			}
			if index+1 < presses {
				time.Sleep(60 * time.Millisecond)
			}
		}
	case "drag":
		fromX, err := a.normalized("from_x")
		if err != nil {
			return nil, err
		}
		fromY, err := a.normalized("from_y")
		if err != nil {
			return nil, err
		}
		toX, err := a.normalized("to_x")
		if err != nil {
			return nil, err
		}
		toY, err := a.normalized("to_y")
		if err != nil {
			return nil, err
		}
		duration, err := a.optionalInteger("duration_ms", 400)
		if err != nil {
			return nil, err
		}
		if duration < 100 || duration > 5000 {
			return nil, failMessage("--duration_ms must be from 100 through 5000")
		}
		startX, startY := bounds.point(fromX, fromY)
		endX, endY := bounds.point(toX, toY)
		if err := connection.pointerTo(startX, startY); err != nil {
			return nil, err
		}
		if err := connection.button(1, true); err != nil {
			return nil, err
		}
		steps := duration / 12
		if steps < 8 {
			steps = 8
		}
		if steps > 120 {
			steps = 120
		}
		for step := 1; step <= steps; step++ {
			progress := float64(step) / float64(steps)
			if err := connection.pointerTo(startX+int(float64(endX-startX)*progress), startY+int(float64(endY-startY)*progress)); err != nil {
				return nil, err
			}
			time.Sleep(time.Duration(duration/steps) * time.Millisecond)
		}
		if err := connection.button(1, false); err != nil {
			return nil, err
		}
	case "scroll":
		deltaY, err := a.optionalInteger("delta_y", 0)
		if err != nil {
			return nil, err
		}
		deltaX, err := a.optionalInteger("delta_x", 0)
		if err != nil {
			return nil, err
		}
		vertical := uint8(4)
		if deltaY < 0 {
			vertical = 5
		}
		horizontal := uint8(6)
		if deltaX < 0 {
			horizontal = 7
		}
		clicks := (abs(deltaY) + 59) / 60
		for index := 0; index < clicks; index++ {
			if err := connection.button(vertical, true); err != nil {
				return nil, err
			}
			if err := connection.button(vertical, false); err != nil {
				return nil, err
			}
		}
		horizontalClicks := (abs(deltaX) + 59) / 60
		for index := 0; index < horizontalClicks; index++ {
			if err := connection.button(horizontal, true); err != nil {
				return nil, err
			}
			if err := connection.button(horizontal, false); err != nil {
				return nil, err
			}
		}
	case "type":
		text, err := a.required("text")
		if err != nil {
			return nil, err
		}
		decoded, err := decodeBase64(text)
		if err != nil {
			return nil, failMessage("--text was not valid UTF-8")
		}
		if len([]rune(decoded)) > 4000 {
			return nil, failMessage("--text must be at most 4000 characters")
		}
		for _, character := range decoded {
			if err := connection.tapKeysym(keysymFor(character)); err != nil {
				return nil, err
			}
		}
	case "key":
		name := strings.ToLower(strings.TrimSpace(a.text("key")))
		keysym, ok := keysyms[name]
		if !ok {
			return nil, failMessage("unsupported key: %s", a.text("key"))
		}
		modifiers, err := linuxModifiers(a.text("flags"))
		if err != nil {
			return nil, err
		}
		for _, modifier := range modifiers {
			if err := connection.keyEvent(modifier, true); err != nil {
				return nil, err
			}
		}
		if err := connection.tapKeysym(keysym); err != nil {
			return nil, err
		}
		for index := len(modifiers) - 1; index >= 0; index-- {
			if err := connection.keyEvent(modifiers[index], false); err != nil {
				return nil, err
			}
		}
	case "focus":
	default:
		return nil, failMessage("unsupported desktop action: %s", action)
	}

	if err := connection.sync(); err != nil {
		return nil, err
	}
	target := map[string]any{"screen": true}
	if needsWindow {
		target = record.json()
	}
	return map[string]any{
		"ok":      true,
		"action":  action,
		"target":  target,
		"bounds":  bounds.json(),
		"display": geometry{X: 0, Y: 0, Width: connection.rootWidth, Height: connection.rootHeight}.json(),
		"session": "x11",
	}, nil
}

func linuxModifiers(value string) ([]uint32, error) {
	var modifiers []uint32
	for _, name := range strings.Split(value, ",") {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		keysym, ok := modifierKeysyms[name]
		if !ok {
			return nil, failMessage("unsupported key modifier: %s", name)
		}
		modifiers = append(modifiers, keysym)
	}
	return modifiers, nil
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

// userIdleMilliseconds asks MIT-SCREEN-SAVER how long the pointer and keyboard
// have been untouched, so the product can refuse to synthesize input while
// someone is working.
//
// The reply layout used here was confirmed against a live server: the saver
// window at offset 8, the countdown to activation at 12, the time since user
// input at 16, and the selected event mask at 20, with the first two summing to
// the server's screen-saver timeout. -1 means this server cannot answer, and the
// product then skips the guard rather than guessing a value.
func (c *xconn) saverReply() ([]byte, error) {
	if c.saver == nil || !c.saver.usable {
		return nil, failMessage("this X server does not answer MIT-SCREEN-SAVER")
	}
	body := make([]byte, 8)
	body[0] = c.saver.opcode
	body[1] = 1 // ScreenSaverQueryInfo
	binary.LittleEndian.PutUint16(body[2:4], 2)
	binary.LittleEndian.PutUint32(body[4:8], c.root)
	c.sequence++
	if _, err := c.conn.Write(body); err != nil {
		c.saver.usable = false
		return nil, err
	}
	reply, err := c.waitReply(c.sequence)
	if err != nil {
		c.saver.usable = false
		return nil, err
	}
	return reply, nil
}

func (c *xconn) userIdleMilliseconds() int {
	reply, err := c.saverReply()
	if err != nil {
		return -1
	}
	return int(u32at(reply, 16))
}

// withFrontmost puts the window actually under the pointer first. QueryTree's
// child order is not something this driver should interpret as "in front": the
// pointer's own window is a fact the server reports, and it is the window a click
// would reach.
func (c *xconn) withFrontmost(records []windowRecordLinux) []windowRecordLinux {
	_, _, child, err := c.queryPointer()
	if err != nil || child == 0 || child == c.root {
		return records
	}
	for index, record := range records {
		if record.window == child || record.ID == int(child) {
			if index == 0 {
				return records
			}
			ordered := make([]windowRecordLinux, 0, len(records))
			ordered = append(ordered, record)
			for position, item := range records {
				if position != index {
					ordered = append(ordered, item)
				}
			}
			return ordered
		}
	}
	return records
}

// verifyPointerTarget reads back which window the pointer is in before a button
// event is sent, so a click can never land on whatever happens to be in front of
// the window the model meant. This is the desktop equivalent of refusing a stale
// element reference.
func (c *xconn) verifyPointerTarget(record windowRecordLinux) error {
	_, _, child, err := c.queryPointer()
	if err != nil || child == 0 {
		return nil
	}
	if child == record.window {
		return nil
	}
	// A frame window owned by a window manager keeps the client it decorates as a
	// descendant, and a click inside the frame is still the client's click.
	if descendant, err := c.isDescendant(child, record.window); err == nil && descendant {
		return nil
	}
	name, title := c.clientName(child)
	description := strings.TrimSpace(strings.Join([]string{name, title}, " "))
	if description == "" {
		description = fmt.Sprintf("window %d", child)
	}
	return failMessage("another window is in front of that one at those coordinates (%s), so no click was sent; bring the intended window forward and act on a fresh capture", description)
}

func (c *xconn) isDescendant(window uint32, ancestor uint32) (bool, error) {
	if window == ancestor {
		return true, nil
	}
	children, err := c.queryTree(ancestor)
	if err != nil {
		return false, err
	}
	for _, child := range children {
		if child == window {
			return true, nil
		}
	}
	return false, nil
}
