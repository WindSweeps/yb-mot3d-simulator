# Local rendering dependency

Three.js r160 (MIT) and its matching OrbitControls module are vendored from the
official `mrdoob/three.js` r160 tag. They are served locally; the demo does not
load runtime code from a CDN.

Sources:
- https://raw.githubusercontent.com/mrdoob/three.js/r160/build/three.module.js
- https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/controls/OrbitControls.js
- https://raw.githubusercontent.com/mrdoob/three.js/r160/LICENSE

The only OrbitControls source edit changes its bare `three` import to
`./three-r160.module.js` for direct browser ES-module loading.

Local SHA-256:

| File | SHA-256 |
|---|---|
| `three-r160.module.js` | `76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495` |
| `OrbitControls-r160.js` (local import adjusted) | `aec3440605eb777645b7df812f85439fe98f5bccebf699843d57c75eecbd729c` |
| `THREE-LICENSE.txt` | `852e0e8699169bf9f6fdc6bda3e682d078dcbc738b5d33e74df594721bff271d` |
