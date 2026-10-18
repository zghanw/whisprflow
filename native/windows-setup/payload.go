package main

import (
	"archive/zip"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// What the installer carries: the exe itself followed by a zip (stored, not compressed), with the last 16 bytes a marker and the zip's length.
// Appending data to an exe is the old self-extracting installer trick; Windows still runs only the program at the front.
// The side that assembles it is scripts/build/windows-setup.mjs; both sides must agree on the format.

const (
	magic       = "SMSETUP1"
	trailerSize = 16
)

var errNoPayload = errors.New("this setup file is incomplete (no package inside); download it again")

// openPayload finds the zip appended to the exe
func openPayload(f *os.File) (*zip.Reader, error) {
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := info.Size()
	if size < trailerSize {
		return nil, errNoPayload
	}
	trailer := make([]byte, trailerSize)
	if _, err := f.ReadAt(trailer, size-trailerSize); err != nil {
		return nil, err
	}
	if string(trailer[:len(magic)]) != magic {
		return nil, errNoPayload
	}
	n := int64(binary.LittleEndian.Uint64(trailer[len(magic):]))
	if n <= 0 || n > size-trailerSize {
		return nil, fmt.Errorf("this setup file is damaged (package size %d of %d); download it again", n, size)
	}
	return zip.NewReader(io.NewSectionReader(f, size-trailerSize-n, n), n)
}

// extract unpacks the zip into dir. Only relative paths inside dir are accepted: the package is our own, but a damaged one shouldn't write anywhere else
func extract(r *zip.Reader, dir string) error {
	for _, entry := range r.File {
		name := filepath.FromSlash(entry.Name)
		if !filepath.IsLocal(name) {
			return fmt.Errorf("unexpected path in the package: %s", entry.Name)
		}
		target := filepath.Join(dir, name)
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := extractFile(entry, target); err != nil {
			return fmt.Errorf("unpacking %s: %w", entry.Name, err)
		}
	}
	return nil
}

func extractFile(entry *zip.File, target string) error {
	in, err := entry.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
