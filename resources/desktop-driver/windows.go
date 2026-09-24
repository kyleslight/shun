//go:build windows

package main

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

/*
The Windows implementation is pure Go: user32 and gdi32 through syscall, no cgo
and no COM, so the same source cross-compiles from the release machine. Window
enumeration comes from EnumWindows, capture from PrintWindow or a screen BitBlt,
and input from SendInput.

Two Windows-specific truths are reported rather than smoothed over:

  - A window owned by an elevated process cannot receive input from a
    non-elevated process (UIPI). That is checked before anything is sent.
  - Raising a window is subject to the foreground lock: SetForegroundWindow may
    refuse, and when it does the result says so instead of implying the window
    came forward.
*/

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	advapi32 = syscall.NewLazyDLL("advapi32.dll")
	dwmapi   = syscall.NewLazyDLL("dwmapi.dll")

	procEnumWindows              = user32.NewProc("EnumWindows")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procIsIconic                 = user32.NewProc("IsIconic")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procGetWindowTextW           = user32.NewProc("GetWindowTextW")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSendInput                = user32.NewProc("SendInput")
	procGetSystemMetrics         = user32.NewProc("GetSystemMetrics")
	procGetLastInputInfo         = user32.NewProc("GetLastInputInfo")
	procGetWindowLongPtrW        = user32.NewProc("GetWindowLongPtrW")
	procGetDC                    = user32.NewProc("GetDC")
	procReleaseDC                = user32.NewProc("ReleaseDC")
	procPrintWindow              = user32.NewProc("PrintWindow")
	procSetProcessDPIAwareness   = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDPIAware       = user32.NewProc("SetProcessDPIAware")

	procCreateCompatibleDC    = gdi32.NewProc("CreateCompatibleDC")
	procDeleteDC              = gdi32.NewProc("DeleteDC")
	procCreateDIBSection      = gdi32.NewProc("CreateDIBSection")
	procSelectObject          = gdi32.NewProc("SelectObject")
	procDeleteObject          = gdi32.NewProc("DeleteObject")
	procBitBlt                = gdi32.NewProc("BitBlt")
	procDwmGetWindowAttribute = dwmapi.NewProc("DwmGetWindowAttribute")
	procOpenProcess           = kernel32.NewProc("OpenProcess")
	procCloseHandle           = kernel32.NewProc("CloseHandle")
	procGetCurrentProcess     = kernel32.NewProc("GetCurrentProcess")
	procGetTickCount          = kernel32.NewProc("GetTickCount")
	procQueryFullProcessImage = kernel32.NewProc("QueryFullProcessImageNameW")
	procOpenProcessToken      = advapi32.NewProc("OpenProcessToken")
	procGetTokenInformation   = advapi32.NewProc("GetTokenInformation")
)

const (
	swRestore = 9

	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCxVirtualScreen = 78
	smCyVirtualScreen = 79
	smCmMonitors      = 80

	dwmwaExtendedFrameBounds = 9
	gwlExStyle               = ^uintptr(19) // GWL_EXSTYLE == -20
	wsExToolWindow           = 0x00000080

	pwRenderFullContent = 2
	srcCopy             = 0x00CC0020
	captureBLT          = 0x40000000
	biRGB               = 0

	inputMouse    = 0
	inputKeyboard = 1

	mouseMove        = 0x0001
	mouseLeftDown    = 0x0002
	mouseLeftUp      = 0x0004
	mouseRightDown   = 0x0008
	mouseRightUp     = 0x0010
	mouseWheel       = 0x0800
	mouseHWheel      = 0x1000
	mouseAbsolute    = 0x8000
	mouseVirtualDesk = 0x4000

	keyEventKeyUp   = 0x0002
	keyEventUnicode = 0x0004

	processQueryLimitedInformation = 0x1000
	tokenQuery                     = 0x0008
	tokenIntegrityLevel            = 25
)

type winRect struct{ Left, Top, Right, Bottom int32 }

func (r winRect) width() int  { return int(r.Right - r.Left) }
func (r winRect) height() int { return int(r.Bottom - r.Top) }
func (r winRect) geometry() geometry {
	return geometry{X: int(r.Left), Y: int(r.Top), Width: r.width(), Height: r.height()}
}

type mouseInput struct {
	Dx        int32
	Dy        int32
	MouseData uint32
	Flags     uint32
	Time      uint32
	_         uint32
	ExtraInfo uintptr
}

type keyboardInput struct {
	Vk        uint16
	Scan      uint16
	Flags     uint32
	Time      uint32
	_         uint32
	ExtraInfo uintptr
}

// input matches INPUT: a DWORD type, alignment padding, then the largest of the
// union members (MOUSEINPUT, 32 bytes on 64-bit Windows).
type input struct {
	Type uint32
	_    uint32
	Data [32]byte
}

type lastInputInfo struct {
	Size uint32
	Time uint32
}

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

func init() {
	// Without per-monitor awareness the driver would read virtualized window
	// rectangles and then click in physical pixels, which lands off target on a
	// scaled display.
	if err := procSetProcessDPIAwareness.Find(); err == nil {
		context := ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == -4
		if ok, _, _ := procSetProcessDPIAwareness.Call(context); ok != 0 {
			return
		}
	}
	procSetProcessDPIAware.Call()
}

func systemMetric(index int) int {
	value, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int(int32(value))
}

func virtualScreen() geometry {
	return geometry{
		X:      systemMetric(smXVirtualScreen),
		Y:      systemMetric(smYVirtualScreen),
		Width:  systemMetric(smCxVirtualScreen),
		Height: systemMetric(smCyVirtualScreen),
	}
}

func foregroundWindow() uintptr {
	handle, _, _ := procGetForegroundWindow.Call()
	return handle
}

func windowText(handle uintptr) string {
	buffer := make([]uint16, 512)
	length, _, _ := procGetWindowTextW.Call(handle, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if length == 0 {
		return ""
	}
	return syscall.UTF16ToString(buffer[:length])
}

func windowProcess(handle uintptr) int {
	var pid uint32
	procGetWindowThreadProcessID.Call(handle, uintptr(unsafe.Pointer(&pid)))
	return int(pid)
}

// windowBounds prefers the DWM extended frame bounds, which are the visible
// edges a person sees; GetWindowRect includes the invisible resize border on
// Windows 10 and later, which would shift every normalized coordinate.
func windowBounds(handle uintptr) (winRect, bool) {
	var extended winRect
	result, _, _ := procDwmGetWindowAttribute.Call(handle, uintptr(dwmwaExtendedFrameBounds), uintptr(unsafe.Pointer(&extended)), unsafe.Sizeof(extended))
	if result == 0 && extended.width() > 0 && extended.height() > 0 {
		return extended, true
	}
	var plain winRect
	if ok, _, _ := procGetWindowRect.Call(handle, uintptr(unsafe.Pointer(&plain))); ok == 0 {
		return winRect{}, false
	}
	return plain, true
}

func processImageName(pid int) string {
	handle, _, _ := procOpenProcess.Call(uintptr(processQueryLimitedInformation), 0, uintptr(uint32(pid)))
	if handle == 0 {
		return ""
	}
	defer procCloseHandle.Call(handle)
	buffer := make([]uint16, 1024)
	size := uint32(len(buffer))
	ok, _, _ := procQueryFullProcessImage.Call(handle, 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)))
	if ok == 0 || size == 0 {
		return ""
	}
	return filepath.Base(syscall.UTF16ToString(buffer[:size]))
}

func applicationName(pid int) string {
	name := processImageName(pid)
	if name == "" {
		return ""
	}
	return strings.TrimSuffix(name, filepath.Ext(name))
}

// integrityRID reads the process integrity level, which is what decides whether
// Windows will deliver synthesized input to it.
func integrityRID(handle uintptr) (uint32, error) {
	var token uintptr
	if ok, _, err := procOpenProcessToken.Call(handle, uintptr(tokenQuery), uintptr(unsafe.Pointer(&token))); ok == 0 {
		return 0, fmt.Errorf("could not inspect that process: %v", err)
	}
	defer procCloseHandle.Call(token)
	var size uint32
	procGetTokenInformation.Call(token, uintptr(tokenIntegrityLevel), 0, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return 0, fmt.Errorf("could not inspect that process integrity level")
	}
	buffer := make([]byte, size)
	if ok, _, err := procGetTokenInformation.Call(token, uintptr(tokenIntegrityLevel), uintptr(unsafe.Pointer(&buffer[0])), uintptr(size), uintptr(unsafe.Pointer(&size))); ok == 0 {
		return 0, fmt.Errorf("could not inspect that process integrity level: %v", err)
	}
	// TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes } }
	sid := *(*unsafe.Pointer)(unsafe.Pointer(&buffer[0]))
	if sid == nil {
		return 0, fmt.Errorf("that process reported no integrity level")
	}
	header := (*[8]byte)(sid)
	count := int(header[1])
	if count < 1 {
		return 0, fmt.Errorf("that process reported no integrity level")
	}
	// The last sub-authority of an integrity SID is the level itself
	// (0x1000 low, 0x2000 medium, 0x3000 high, 0x4000 system).
	subAuthority := (*uint32)(unsafe.Add(sid, 8+uintptr(count-1)*4))
	return *subAuthority, nil
}

func elevatedTargetBlocked(pid int) (bool, error) {
	handle, _, _ := procOpenProcess.Call(uintptr(processQueryLimitedInformation), 0, uintptr(uint32(pid)))
	if handle == 0 {
		// A process that cannot even be inspected is not one Windows will accept
		// input for from here, but the reason is unknown, so nothing is claimed.
		return false, nil
	}
	defer procCloseHandle.Call(handle)
	target, err := integrityRID(handle)
	if err != nil {
		return false, nil
	}
	self, err := integrityRID(currentProcess())
	if err != nil {
		return false, nil
	}
	return target > self, nil
}

func currentProcess() uintptr {
	handle, _, _ := procGetCurrentProcess.Call()
	return handle
}

func onScreenWindows() ([]windowRecord, error) {
	ownPid := os.Getpid()
	var records []windowRecord
	callback := syscall.NewCallback(func(handle uintptr, _ uintptr) uintptr {
		visible, _, _ := procIsWindowVisible.Call(handle)
		if visible == 0 {
			return 1
		}
		iconic, _, _ := procIsIconic.Call(handle)
		if iconic != 0 {
			return 1
		}
		style, _, _ := procGetWindowLongPtrW.Call(handle, gwlExStyle)
		if style&wsExToolWindow != 0 {
			return 1
		}
		bounds, ok := windowBounds(handle)
		if !ok || bounds.width() < minimumWindowSize || bounds.height() < minimumWindowSize {
			return 1
		}
		pid := windowProcess(handle)
		if pid == ownPid {
			return 1
		}
		records = append(records, windowRecord{
			ID:     int(handle),
			PID:    pid,
			App:    boundedText(applicationName(pid), 120),
			Title:  boundedText(windowText(handle), 300),
			Layer:  0,
			X:      int(bounds.Left),
			Y:      int(bounds.Top),
			Width:  bounds.width(),
			Height: bounds.height(),
		})
		return 1
	})
	if ok, _, err := procEnumWindows.Call(callback, 0); ok == 0 {
		return nil, fmt.Errorf("Windows could not enumerate the windows on screen: %v", err)
	}
	// EnumWindows walks the Z-order from front to back, so the foreground window
	// is moved to the front of the list the model reads.
	front := foregroundWindow()
	for index, record := range records {
		if uintptr(record.ID) == front && index > 0 {
			records = append([]windowRecord{record}, append(records[:index], records[index+1:]...)...)
			break
		}
	}
	return records, nil
}

func resolveWindow(selector string) (windowRecord, error) {
	windows, err := onScreenWindows()
	if err != nil {
		return windowRecord{}, err
	}
	if len(windows) == 0 {
		return windowRecord{}, fmt.Errorf("no on-screen window is available to act on")
	}
	selector = strings.TrimSpace(selector)
	if selector == "" || strings.EqualFold(selector, "frontmost") {
		front := foregroundWindow()
		for _, record := range windows {
			if uintptr(record.ID) == front {
				return record, nil
			}
		}
		return windows[0], nil
	}
	if id, err := parseWindowID(selector); err == nil {
		for _, record := range windows {
			if record.ID == id {
				return record, nil
			}
		}
		return windowRecord{}, fmt.Errorf("no on-screen window has id %d; list windows again and use a current id", id)
	}
	var matches []windowRecord
	for _, record := range windows {
		if strings.EqualFold(record.App, selector) || strings.EqualFold(record.Title, selector) {
			matches = append(matches, record)
		}
	}
	if len(matches) > 1 {
		return windowRecord{}, fmt.Errorf("more than one window matches %s; use an exact window id from the window list", selector)
	}
	if len(matches) == 0 {
		return windowRecord{}, fmt.Errorf("no on-screen window matches %s; list windows again and use an exact id", selector)
	}
	return matches[0], nil
}

func raiseWindow(record windowRecord) bool {
	handle := uintptr(record.ID)
	procShowWindow.Call(handle, swRestore)
	ok, _, _ := procSetForegroundWindow.Call(handle)
	return ok != 0
}

func probeResult() (map[string]any, error) {
	windows, err := onScreenWindows()
	if err != nil {
		return nil, err
	}
	front := foregroundWindow()
	frontPid := windowProcess(front)
	return map[string]any{
		"ok":               true,
		"accessibility":    true,
		"screen_recording": true,
		"user_idle_ms":     userIdleMilliseconds(),
		"capture": map[string]any{
			"supported": true,
			"displays":  systemMetric(smCmMonitors),
			"windows":   len(windows),
		},
		"display":             virtualScreen().json(),
		"frontmost":           boundedText(windowText(front), 200),
		"frontmost_bundle_id": processImageName(frontPid),
	}, nil
}

func userIdleMilliseconds() int {
	info := lastInputInfo{Size: uint32(unsafe.Sizeof(lastInputInfo{}))}
	if ok, _, _ := procGetLastInputInfo.Call(uintptr(unsafe.Pointer(&info))); ok == 0 {
		return 0
	}
	now, _, _ := procGetTickCount.Call()
	return int(uint32(now) - info.Time)
}

func windowsResult() (map[string]any, error) {
	windows, err := onScreenWindows()
	if err != nil {
		return nil, err
	}
	front := foregroundWindow()
	frontPid := windowProcess(front)
	rows := make([]map[string]any, 0, len(windows))
	for _, record := range windows {
		rows = append(rows, record.json())
	}
	return map[string]any{
		"ok": true,
		"frontmost": map[string]any{
			"app":       boundedText(applicationName(frontPid), 120),
			"pid":       frontPid,
			"bundle_id": processImageName(frontPid),
		},
		"display": virtualScreen().json(),
		"windows": rows,
	}, nil
}

type dib struct {
	handle uintptr
	// A DIB section's pixel buffer is GDI memory, so it is held as an unsafe
	// pointer and never as a uintptr: that is the one conversion that keeps go vet
	// and the garbage collector happy about memory Go does not own.
	bits   unsafe.Pointer
	width  int
	height int
}

func newDIB(width int, height int) (dib, error) {
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return dib{}, fmt.Errorf("Windows did not provide a screen device context")
	}
	memory, _, _ := procCreateCompatibleDC.Call(screen)
	if memory == 0 {
		procReleaseDC.Call(0, screen)
		return dib{}, fmt.Errorf("Windows could not create a capture device context")
	}
	header := bitmapInfoHeader{Size: uint32(unsafe.Sizeof(bitmapInfoHeader{})), Width: int32(width), Height: int32(-height), Planes: 1, BitCount: 32, Compression: biRGB}
	var bits unsafe.Pointer
	bitmap, _, _ := procCreateDIBSection.Call(memory, uintptr(unsafe.Pointer(&header)), uintptr(biRGB), uintptr(unsafe.Pointer(&bits)), 0, 0)
	procReleaseDC.Call(0, screen)
	if bitmap == 0 || bits == nil {
		procDeleteDC.Call(memory)
		return dib{}, fmt.Errorf("Windows could not allocate a %dx%d capture surface", width, height)
	}
	procSelectObject.Call(memory, bitmap)
	return dib{handle: bitmap, bits: bits, width: width, height: height}, nil
}

func (d dib) release() {
	procDeleteObject.Call(d.handle)
}

func (d dib) image() *image.RGBA {
	bytes := unsafe.Slice((*byte)(d.bits), d.width*d.height*4)
	captured := image.NewRGBA(image.Rect(0, 0, d.width, d.height))
	for y := 0; y < d.height; y++ {
		row := bytes[y*d.width*4:]
		destination := captured.Pix[y*captured.Stride:]
		for x := 0; x < d.width; x++ {
			// A DIB section is BGRA; alpha comes back unused.
			destination[x*4] = row[x*4+2]
			destination[x*4+1] = row[x*4+1]
			destination[x*4+2] = row[x*4]
			destination[x*4+3] = 255
		}
	}
	return captured
}

func captureSurface(target string) (dib, geometry, string, error) {
	if target == "screen" {
		bounds := virtualScreen()
		if !bounds.valid() {
			return dib{}, geometry{}, "", fmt.Errorf("Windows reports no display size to capture")
		}
		surface, err := newDIB(bounds.Width, bounds.Height)
		if err != nil {
			return dib{}, geometry{}, "", err
		}
		screen, _, _ := procGetDC.Call(0)
		memory, _, _ := procCreateCompatibleDC.Call(screen)
		procSelectObject.Call(memory, surface.handle)
		ok, _, err := procBitBlt.Call(memory, 0, 0, uintptr(bounds.Width), uintptr(bounds.Height), screen, uintptr(bounds.X), uintptr(bounds.Y), uintptr(srcCopy|captureBLT))
		procDeleteDC.Call(memory)
		procReleaseDC.Call(0, screen)
		if ok == 0 {
			surface.release()
			return dib{}, geometry{}, "", fmt.Errorf("Windows could not copy the screen: %v", err)
		}
		return surface, bounds, "screen_blit", nil
	}
	record, err := resolveWindow(target)
	if err != nil {
		return dib{}, geometry{}, "", err
	}
	bounds := record.geometry()
	surface, err := newDIB(bounds.Width, bounds.Height)
	if err != nil {
		return dib{}, geometry{}, "", err
	}
	screen, _, _ := procGetDC.Call(0)
	memory, _, _ := procCreateCompatibleDC.Call(screen)
	procSelectObject.Call(memory, surface.handle)
	// PrintWindow renders the window even when it is covered; some GPU-composited
	// windows answer blank, so a screen copy of the same rectangle is the fallback.
	printed, _, _ := procPrintWindow.Call(uintptr(record.ID), memory, uintptr(pwRenderFullContent))
	method := "print_window"
	if printed == 0 {
		method = "screen_blit"
		copied, _, err := procBitBlt.Call(memory, 0, 0, uintptr(bounds.Width), uintptr(bounds.Height), screen, uintptr(bounds.X), uintptr(bounds.Y), uintptr(srcCopy|captureBLT))
		if copied == 0 {
			procDeleteDC.Call(memory)
			procReleaseDC.Call(0, screen)
			surface.release()
			return dib{}, geometry{}, "", fmt.Errorf("Windows could not capture window %d: %v", record.ID, err)
		}
	}
	procDeleteDC.Call(memory)
	procReleaseDC.Call(0, screen)
	return surface, bounds, method, nil
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
	surface, bounds, method, err := captureSurface(target)
	if err != nil {
		return nil, err
	}
	defer surface.release()
	if err := writePNG(surface.image(), out); err != nil {
		return nil, err
	}
	result := map[string]any{
		"ok":      true,
		"target":  "screen",
		"method":  method,
		"display": virtualScreen().json(),
		"bounds":  bounds.json(),
	}
	if target != "screen" {
		record, err := resolveWindow(target)
		if err != nil {
			return nil, err
		}
		result["target"] = "window"
		result["window"] = record.json()
	}
	return result, nil
}

func writePNG(captured image.Image, path string) error {
	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("could not write the capture: %w", err)
	}
	defer file.Close()
	if err := png.Encode(file, captured); err != nil {
		return fmt.Errorf("could not encode the capture as PNG: %w", err)
	}
	return nil
}

func sendInputs(items []input) error {
	if len(items) == 0 {
		return nil
	}
	sent, _, err := procSendInput.Call(uintptr(len(items)), uintptr(unsafe.Pointer(&items[0])), unsafe.Sizeof(input{}))
	if int(sent) != len(items) {
		return fmt.Errorf("Windows refused %d of %d synthesized input events (%v). An application that runs elevated cannot receive input from a non-elevated process", len(items)-int(sent), len(items), err)
	}
	return nil
}

func mouseEvent(flags uint32, x int, y int, data int32) input {
	item := input{Type: inputMouse}
	mouse := (*mouseInput)(unsafe.Pointer(&item.Data[0]))
	mouse.Flags = flags
	mouse.MouseData = uint32(data)
	if flags&(mouseMove|mouseAbsolute) != 0 {
		screen := virtualScreen()
		width, height := screen.Width, screen.Height
		if width > 1 && height > 1 {
			mouse.Dx = int32(float64(x-screen.X) * 65535 / float64(width-1))
			mouse.Dy = int32(float64(y-screen.Y) * 65535 / float64(height-1))
		}
	}
	return item
}

func keyboardEvent(vk uint16, scan uint16, flags uint32) input {
	item := input{Type: inputKeyboard}
	keyboard := (*keyboardInput)(unsafe.Pointer(&item.Data[0]))
	keyboard.Vk = vk
	keyboard.Scan = scan
	keyboard.Flags = flags
	return item
}

var windowsKeys = map[string]uint16{
	"return": 0x0D, "enter": 0x0D, "tab": 0x09, "space": 0x20,
	"delete": 0x08, "forward_delete": 0x2E, "escape": 0x1B,
	"left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
	"home": 0x24, "end": 0x23, "page_up": 0x21, "page_down": 0x22,
}

var windowsFlags = map[string]uint16{"cmd": 0x5B, "command": 0x5B, "meta": 0x5B, "shift": 0x10, "alt": 0x12, "option": 0x12, "ctrl": 0x11, "control": 0x11}

func actResult(a arguments) (map[string]any, error) {
	action, err := a.required("action")
	if err != nil {
		return nil, err
	}
	selector := strings.TrimSpace(a.text("window"))
	var record windowRecord
	if action != "key" {
		record, err = resolveWindow(selector)
		if err != nil {
			return nil, err
		}
		if blocked, _ := elevatedTargetBlocked(record.PID); blocked {
			return nil, fmt.Errorf("that window belongs to an application running elevated, and Windows blocks synthesized input into it from a non-elevated process; run Shun elevated or use the application's own interface")
		}
	}
	bounds := virtualScreen()
	if action != "key" {
		bounds = record.geometry()
	}
	events := []input{}
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
		down, up := uint32(mouseLeftDown), uint32(mouseLeftUp)
		if action == "right_click" {
			down, up = mouseRightDown, mouseRightUp
		}
		events = append(events, mouseEvent(mouseMove|mouseAbsolute|mouseVirtualDesk, px, py, 0))
		count := 1
		if action == "double_click" {
			count = 2
		}
		for index := 0; index < count; index++ {
			events = append(events, mouseEvent(down|mouseAbsolute|mouseVirtualDesk, px, py, 0), mouseEvent(up|mouseAbsolute|mouseVirtualDesk, px, py, 0))
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
			return nil, fmt.Errorf("--duration_ms must be from 100 through 5000")
		}
		startX, startY := bounds.point(fromX, fromY)
		endX, endY := bounds.point(toX, toY)
		events = append(events, mouseEvent(mouseMove|mouseAbsolute|mouseVirtualDesk, startX, startY, 0), mouseEvent(mouseLeftDown|mouseAbsolute|mouseVirtualDesk, startX, startY, 0))
		steps := duration / 12
		if steps < 8 {
			steps = 8
		}
		if steps > 120 {
			steps = 120
		}
		for step := 1; step <= steps; step++ {
			progress := float64(step) / float64(steps)
			events = append(events, mouseEvent(mouseMove|mouseAbsolute|mouseVirtualDesk, startX+int(float64(endX-startX)*progress), startY+int(float64(endY-startY)*progress), 0))
		}
		events = append(events, mouseEvent(mouseLeftUp|mouseAbsolute|mouseVirtualDesk, endX, endY, 0))
	case "scroll":
		deltaY, err := a.optionalInteger("delta_y", 0)
		if err != nil {
			return nil, err
		}
		deltaX, err := a.optionalInteger("delta_x", 0)
		if err != nil {
			return nil, err
		}
		if deltaY != 0 {
			events = append(events, mouseEvent(mouseWheel, 0, 0, int32(deltaY)))
		}
		if deltaX != 0 {
			events = append(events, mouseEvent(mouseHWheel, 0, 0, int32(deltaX)))
		}
	case "type":
		text, err := a.required("text")
		if err != nil {
			return nil, err
		}
		decoded, err := decodeText(text)
		if err != nil {
			return nil, err
		}
		if len(decoded) > 4000 {
			return nil, fmt.Errorf("--text must be at most 4000 characters")
		}
		for _, character := range decoded {
			if character == '\n' || character == '\r' {
				events = append(events, keyboardEvent(windowsKeys["return"], 0, 0), keyboardEvent(windowsKeys["return"], 0, keyEventKeyUp))
				continue
			}
			units := syscall.StringToUTF16(string(character))
			for _, unit := range units[:len(units)-1] {
				events = append(events, keyboardEvent(0, unit, keyEventUnicode), keyboardEvent(0, unit, keyEventUnicode|keyEventKeyUp))
			}
		}
	case "key":
		name := strings.ToLower(strings.TrimSpace(a.text("key")))
		virtual, ok := windowsKeys[name]
		if !ok {
			return nil, fmt.Errorf("unsupported key: %s", a.text("key"))
		}
		modifiers, err := windowsModifiers(a.text("flags"))
		if err != nil {
			return nil, err
		}
		for _, modifier := range modifiers {
			events = append(events, keyboardEvent(modifier, 0, 0))
		}
		events = append(events, keyboardEvent(virtual, 0, 0), keyboardEvent(virtual, 0, keyEventKeyUp))
		for index := len(modifiers) - 1; index >= 0; index-- {
			events = append(events, keyboardEvent(modifiers[index], 0, keyEventKeyUp))
		}
	case "focus":
	default:
		return nil, fmt.Errorf("unsupported desktop action: %s", action)
	}

	raised := false
	if action == "focus" || (record.ID != 0 && action != "key") {
		raised = raiseWindow(record)
	}
	if err := sendInputs(events); err != nil {
		return nil, err
	}
	target := map[string]any{"screen": true}
	if action != "key" {
		target = record.json()
	}
	return map[string]any{
		"ok":      true,
		"action":  action,
		"target":  target,
		"bounds":  bounds.json(),
		"raised":  raised,
		"display": virtualScreen().json(),
	}, nil
}

func windowsModifiers(value string) ([]uint16, error) {
	var modifiers []uint16
	for _, name := range strings.Split(value, ",") {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		virtual, ok := windowsFlags[name]
		if !ok {
			return nil, fmt.Errorf("unsupported key modifier: %s", name)
		}
		modifiers = append(modifiers, virtual)
	}
	return modifiers, nil
}

func decodeText(value string) (string, error) {
	decoded, err := decodeBase64(value)
	if err != nil {
		return "", fmt.Errorf("--text was not valid UTF-8")
	}
	return decoded, nil
}
