SHELL := /bin/sh

.PHONY: test verify-cloud-dev build build-adapters build-macos image-arm64 image-amd64

test:
	go test ./...

verify-cloud-dev:
	./scripts/verify-cloud-dev.sh

build:
	go build -trimpath -o bin/zapvm ./cmd/zapvm

build-adapters:
	go build -trimpath -o bin/zapvm-agent-adapter ./cmd/zapvm-agent-adapter

build-macos: build
	codesign --force --sign - --entitlements packaging/macos/zapvm.entitlements bin/zapvm

image-arm64:
	ZAPVM_REPLACE_OUTPUT=1 ./scripts/build-rootfs.sh arm64

image-amd64:
	ZAPVM_REPLACE_OUTPUT=1 ./scripts/build-rootfs.sh amd64
