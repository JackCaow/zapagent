//go:build !darwin && !linux

package state

func copyStateFile(sourcePath, destinationPath string) error {
	return copyStateFallback(sourcePath, destinationPath)
}
