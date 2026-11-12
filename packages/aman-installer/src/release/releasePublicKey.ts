// THE RELEASE PUBLIC KEY lives on this one line, and only here.
//
// This is the owner's real release public key. A release record is
// trusted only when its signature checks out against this key, which
// means it was signed with the matching private key. The private key
// stays with the owner and is never in this repository. A manifest
// signed with any other key does not check out against the key
// compiled in here.
export const RELEASE_PUBLIC_KEY_MINISIGN = 'RWR8aR0vofffsH8dRDfeCxHcPAo2hBKQp6W9krptCFjneeXPDr+ZB0wr';
