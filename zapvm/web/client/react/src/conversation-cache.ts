export function isCompleteConversationSnapshot(
  cachedFingerprint: string,
  cachedTurnIDs: string[],
  conversationFingerprint: string,
  conversationTurnIDs: string[],
) {
  return cachedFingerprint === conversationFingerprint &&
    cachedTurnIDs.length === conversationTurnIDs.length &&
    cachedTurnIDs.every((id, index) => id === conversationTurnIDs[index]);
}
