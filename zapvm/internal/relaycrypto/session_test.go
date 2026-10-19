package relaycrypto

import (
	"bytes"
	"testing"
)

func TestBrowserGuestSessionRoundTripAndReplayFence(t *testing.T) {
	browserPair, err := GenerateKeyPair(nil)
	if err != nil {
		t.Fatal(err)
	}
	guestPair, err := GenerateKeyPair(nil)
	if err != nil {
		t.Fatal(err)
	}
	context := Context{TenantID: "acme", ProjectID: "default", SessionID: "session-a", TaskID: "task-a", KeyID: "epoch-1"}
	browser, err := Establish(browserPair, guestPair.PublicKey(), RoleBrowser, context)
	if err != nil {
		t.Fatal(err)
	}
	guest, err := Establish(guestPair, browserPair.PublicKey(), RoleGuest, context)
	if err != nil {
		t.Fatal(err)
	}
	prompt, err := browser.Seal([]byte("run tests"))
	if err != nil {
		t.Fatal(err)
	}
	opened, err := guest.Open(prompt)
	if err != nil || !bytes.Equal(opened, []byte("run tests")) {
		t.Fatalf("opened=%q err=%v", opened, err)
	}
	if _, err := guest.Open(prompt); err == nil {
		t.Fatal("Guest accepted a replayed Browser envelope")
	}
	answer, err := guest.Seal([]byte("tests passed"))
	if err != nil {
		t.Fatal(err)
	}
	opened, err = browser.Open(answer)
	if err != nil || !bytes.Equal(opened, []byte("tests passed")) {
		t.Fatalf("opened=%q err=%v", opened, err)
	}
}

func TestSessionRejectsCrossTaskCiphertextAndTampering(t *testing.T) {
	left, _ := GenerateKeyPair(nil)
	right, _ := GenerateKeyPair(nil)
	context := Context{TenantID: "acme", ProjectID: "default", SessionID: "session-a", TaskID: "task-a", KeyID: "epoch-1"}
	browser, _ := Establish(left, right.PublicKey(), RoleBrowser, context)
	envelope, _ := browser.Seal([]byte("secret"))
	context.TaskID = "task-b"
	guest, _ := Establish(right, left.PublicKey(), RoleGuest, context)
	if _, err := guest.Open(envelope); err == nil {
		t.Fatal("Guest accepted ciphertext bound to another Task")
	}
	context.TaskID = "task-a"
	guest, _ = Establish(right, left.PublicKey(), RoleGuest, context)
	envelope.Ciphertext[0] ^= 0xff
	if _, err := guest.Open(envelope); err == nil {
		t.Fatal("Guest accepted tampered ciphertext")
	}
}
