package main

import (
	"os"
	"strings"
)

const (
	imageRootEnvironment      = "ZAPVM_IMAGE_ROOT"
	imagePublicKeyEnvironment = "ZAPVM_IMAGE_PUBLIC_KEY"
)

func configuredImageDefaults() (string, string) {
	return strings.TrimSpace(os.Getenv(imageRootEnvironment)),
		strings.TrimSpace(os.Getenv(imagePublicKeyEnvironment))
}
