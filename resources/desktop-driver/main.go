// Command desktop-driver is the Windows and Linux half of Shun's Computer Use
// driver. The macOS half is resources/desktop-driver.swift, and both implement
// the same command line contract so one service in the product can drive any of
// them:
//
//	probe                          session facts: permissions, idle input, capture, frontmost
//	windows                        on-screen windows with ids and geometry
//	snapshot --window <sel> --out <path>   capture a window, or the display with --window screen
//	act --action <name> [...]      synthesize real input, then the caller captures again
//
// Output is one JSON object on stdout and diagnostics on stderr, exactly as the
// Swift driver does. A capture is written to --out instead of stdout so a
// screenshot never competes with the JSON reply for the same pipe.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
)

// A window smaller than this in either direction is chrome rather than a surface
// worth acting on. The Swift driver uses the same floor.
const minimumWindowSize = 120

type arguments struct {
	command string
	values  map[string]string
}

func parseArguments(raw []string) (arguments, error) {
	if len(raw) == 0 {
		return arguments{}, fmt.Errorf("a desktop driver command is required")
	}
	parsed := arguments{command: raw[0], values: map[string]string{}}
	for index := 1; index < len(raw); index++ {
		token := raw[index]
		if !strings.HasPrefix(token, "--") {
			return arguments{}, fmt.Errorf("unexpected desktop driver argument: %s", token)
		}
		if index+1 >= len(raw) {
			return arguments{}, fmt.Errorf("desktop driver argument %s requires a value", token)
		}
		parsed.values[strings.TrimPrefix(token, "--")] = raw[index+1]
		index++
	}
	return parsed, nil
}

func (a arguments) text(name string) string { return a.values[name] }

func (a arguments) has(name string) bool { _, ok := a.values[name]; return ok }

// A window id is decimal on every platform: an HWND, an X11 window, and the
// number the model was given in a window list are the same kind of handle here.
func parseWindowID(value string) (int, error) {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s is not a window id", value)
	}
	return parsed, nil
}

func (a arguments) required(name string) (string, error) {
	value := strings.TrimSpace(a.values[name])
	if value == "" {
		return "", fmt.Errorf("--%s is required", name)
	}
	return value, nil
}

func (a arguments) number(name string) (float64, error) {
	value, err := a.required(name)
	if err != nil {
		return 0, err
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, fmt.Errorf("--%s must be a number", name)
	}
	return parsed, nil
}

func (a arguments) integer(name string) (int, error) {
	value, err := a.required(name)
	if err != nil {
		return 0, err
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("--%s must be an integer", name)
	}
	return parsed, nil
}

func (a arguments) optionalInteger(name string, fallback int) (int, error) {
	if !a.has(name) {
		return fallback, nil
	}
	return a.integer(name)
}

// normalized is the coordinate contract the model sees: 0 at the top or left of
// the captured surface through 1 at the bottom or right of it.
func (a arguments) normalized(name string) (float64, error) {
	value, err := a.number(name)
	if err != nil {
		return 0, err
	}
	if value < 0 || value > 1 {
		return 0, fmt.Errorf("--%s must be a normalized coordinate from 0 through 1", name)
	}
	return value, nil
}

type geometry struct {
	X      int
	Y      int
	Width  int
	Height int
}

func (g geometry) json() map[string]any {
	return map[string]any{"x": g.X, "y": g.Y, "width": g.Width, "height": g.Height}
}

func (g geometry) valid() bool { return g.Width > 0 && g.Height > 0 }

// point maps a normalized coordinate onto a surface, which is what makes an
// action independent of the capture's pixel size or display scale.
func (g geometry) point(x float64, y float64) (int, int) {
	return g.X + int(math.Round(float64(g.Width)*x)), g.Y + int(math.Round(float64(g.Height)*y))
}

type windowRecord struct {
	ID     int    `json:"id"`
	PID    int    `json:"pid"`
	App    string `json:"app"`
	Title  string `json:"title"`
	Layer  int    `json:"layer"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

func (w windowRecord) geometry() geometry {
	return geometry{X: w.X, Y: w.Y, Width: w.Width, Height: w.Height}
}

func (w windowRecord) json() map[string]any {
	return map[string]any{
		"id": w.ID, "pid": w.PID, "app": w.App, "title": w.Title, "layer": w.Layer,
		"x": w.X, "y": w.Y, "width": w.Width, "height": w.Height,
	}
}

func boundedText(value string, limit int) string {
	value = strings.TrimSpace(strings.Join(strings.Fields(value), " "))
	if len(value) > limit {
		return value[:limit]
	}
	return value
}

// Both drivers take typed text as base64 so a value can never be confused with
// a flag, and so a newline survives the command line intact.
func decodeBase64(value string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func emit(value map[string]any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		fail(fmt.Errorf("could not encode the desktop driver response: %w", err))
	}
	fmt.Println(string(encoded))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(1)
}

func main() {
	parsed, err := parseArguments(os.Args[1:])
	if err != nil {
		fail(err)
	}
	var out map[string]any
	switch parsed.command {
	case "probe":
		out, err = probeResult()
	case "windows":
		out, err = windowsResult()
	case "snapshot":
		out, err = snapshotResult(parsed)
	case "act":
		out, err = actResult(parsed)
	default:
		err = fmt.Errorf("unsupported desktop driver command: %s", parsed.command)
	}
	if err != nil {
		fail(err)
	}
	emit(out)
}
