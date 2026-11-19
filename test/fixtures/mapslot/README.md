# mapslot fixture

Two ACS libraries for the map-var tools' `sourceFile` path: a public scalar and
array, a hidden scalar initialised nonzero, a hidden zero scalar, a hidden array and a struct
array with known nonzero elements, two public vars the library's own code never touches, and a
named getter script per hidden var.

- `mapslot.bcs`: compact `ACSe`, names `ms_*`, values 101-105.
- `mapslotn.bcs`: the same shape with `#nocompact` (`ACSE`), names `mn_*`, values 201-205.

`res/` is a launch directory (`-file test/fixtures/mapslot/res`): its `LOADACS` loads both. `probe/`
holds each source with six probes appended (`probeSource` of `EXPRS` in `test/probe.test.ts`,
which checks the copy) and its build, the decoder's golden. Keep `probe/` out of the launch dir: a
launch file's modules are what build A is matched against.

`import/` is an import pair, also outside the launch dir: `msimp.bcs` `#import`s `msimplib.bcs`,
so its build lists `mil_v` in `MIMP` and `mil_arr` in `AIMP`, which `sourceFile` refuses.

## Build

With `bcc` (zt-bcc) on PATH, from the repo root:

```
cd test/fixtures/mapslot && bcc mapslot.bcs res/acs/mapslot.o && bcc mapslotn.bcs res/acs/mapslotn.o && cd probe && bcc mapslot.bcs mapslot.o && bcc mapslotn.bcs mapslotn.o && cd ../import && bcc msimp.bcs msimp.o
```

After editing a source, regenerate its `probe/` copy as the source plus the probe text the test
prints on a mismatch, then rebuild both.
