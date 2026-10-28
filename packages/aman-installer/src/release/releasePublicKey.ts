// THE RELEASE PUBLIC KEY lives on this one line, and only here.
//
// What is on the line today is a TEST key, made for this change so the
// signing and checking could be built and proven. It signs nothing
// real. Before this change merges, this one value is replaced with the
// owner's real minisign public key, the one whose private part the
// owner keeps and signs releases with. A manifest signed with any
// other key does not check out against the key compiled in here.
export const RELEASE_PUBLIC_KEY_MINISIGN = 'RWS0Gj0C7C8Rs61nm8GmQwQmvsvt0yXPzlrvVDJqgVoKq9/xrzdWCIHR';
