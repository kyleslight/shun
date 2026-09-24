//go:build !windows && !linux

package main

import "fmt"

// macOS is driven by resources/desktop-driver.swift, which needs AppKit and
// ScreenCaptureKit and therefore cannot be one of these Go builds. Building the
// Go driver for another platform is a mistake, and it says so rather than
// producing a binary that would silently do nothing.
func unsupported() error {
	return fmt.Errorf("this Go desktop driver is built for Windows and Linux; macOS uses the Swift driver")
}

func probeResult() (map[string]any, error)               { return nil, unsupported() }
func windowsResult() (map[string]any, error)             { return nil, unsupported() }
func snapshotResult(a arguments) (map[string]any, error) { return nil, unsupported() }
func actResult(a arguments) (map[string]any, error)      { return nil, unsupported() }
