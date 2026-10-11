# Third-party Notices / 第三方声明

This project is a derivative work of, and gratefully builds upon:

* JasonYu0822/opencode2pi-desktop (MIT) — direct porting source.
* FishBottle7/opencode2dsh (MIT, © FishBottle7) — upstream of the above;
  disguise headers, canonical session id shape, S1∩S2 catalog chain.
* eric8bit/pi-commandcode-desktop (MIT) — loopback + static provider
  declaration architecture pattern.
* jasonxu114514/opencode2api (GPL-3.0) — origin of the disguise approach.
  This project copies no code from it; the protocol parameters it pioneered
  (header names, session id shape, free-lane body requirements) are
  functional facts re-verified independently via our own packet captures
  (rust/tests/capture-opencode-request.mjs, replay-gate-probe.mjs).

Their MIT license texts and copyright notices are preserved via the
attribution in README.md and in the source file headers.
