package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// fakeSetup builds a fake installer the way scripts/build/windows-setup.mjs assembles one: a "program" up front, followed by the zip and marker
func fakeSetup(t *testing.T, files map[string]string, mangle func([]byte) []byte) string {
	t.Helper()
	var payload bytes.Buffer
	w := zip.NewWriter(&payload)
	for name, content := range files {
		f, err := w.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(content))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	trailer := make([]byte, trailerSize)
	copy(trailer, magic)
	binary.LittleEndian.PutUint64(trailer[len(magic):], uint64(payload.Len()))
	data := append(append([]byte("MZ the program itself"), payload.Bytes()...), trailer...)
	if mangle != nil {
		data = mangle(data)
	}
	path := filepath.Join(t.TempDir(), "WhisprFlow-Setup-x64.exe")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func open(t *testing.T, path string) (*zip.Reader, error) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return openPayload(f)
}

func TestPayloadUnpacksIntoTheDirectory(t *testing.T) {
	path := fakeSetup(t, map[string]string{
		"latest/download/latest":                          "v0.9.0\n",
		"install.ps1":                                     "& { 'hi' }",
		"download/v0.9.0/whisprflow-win32-x64.zip":        "zip",
		"download/v0.9.0/whisprflow-win32-x64.zip.sha256": "abc  whisprflow-win32-x64.zip\n",
	}, nil)
	r, err := open(t, path)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := extract(r, dir); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "download", "v0.9.0", "whisprflow-win32-x64.zip.sha256"))
	if err != nil || string(got) != "abc  whisprflow-win32-x64.zip\n" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestPlainExeWithoutPayloadIsRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "plain.exe")
	os.WriteFile(path, []byte("MZ an ordinary program with nothing appended"), 0o644)
	if _, err := open(t, path); err != errNoPayload {
		t.Fatalf("got %v", err)
	}
}

func TestTruncatedDownloadIsRejected(t *testing.T) {
	// A download cut off midway: the marker is still at the end here (a half-downloaded file has none), simulating a length mismatch
	path := fakeSetup(t, map[string]string{"latest": "v0.9.0\n"}, func(data []byte) []byte {
		return append(data[:10], data[len(data)-trailerSize:]...)
	})
	if _, err := open(t, path); err == nil {
		t.Fatal("a package with a mismatched length was taken as good")
	}
}

func TestPathsOutsideTheDirectoryAreRefused(t *testing.T) {
	path := fakeSetup(t, map[string]string{"../escape.txt": "x"}, nil)
	r, err := open(t, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := extract(r, t.TempDir()); err == nil {
		t.Fatal("a path starting with ../ was extracted")
	}
}
