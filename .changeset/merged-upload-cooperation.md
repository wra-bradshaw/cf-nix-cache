---
'cf-nix-cache': patch
---

Finish an upload another push abandoned. When two pushes of the same store path ran at once, the second merged into the first's in-flight upload and only polled for its result, so if the first client died while uploading, the second waited for the in-flight entry to expire, up to an hour. A merged push whose chunk list is byte-identical to the upload's is now handed the chunks still missing and can upload and complete them itself; a push whose encoder produced different chunks gets an upload of its own rather than sharing one it could not contribute to.
