// dumpbin /dependents lists both normal and delay-loaded DLL dependencies.
export function parseDependencies(output) {
  const libraries = [...new Set(output.split(/\r?\n/).map(line => line.trim())
    .filter(line => /^[a-z0-9_.-]+\.dll$/i.test(line)).map(line => line.toLowerCase()))].sort();
  if (!libraries.length) throw new Error('No DLL imports found; dependency inspection failed.');
  return libraries;
}

export function assertNoRedistributable(libraries, filename) {
  const external = libraries.filter(name => /^(?:vcruntime|msvcp|msvcr|concrt|vcomp)\d.*\.dll$|^ucrtbased\.dll$/i.test(name));
  if (external.length) throw new Error(`${filename} requires external Visual C++ runtime DLLs: ${external.join(', ')}`);
}

export function assertWindowsX64(bytes, filename) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`Missing DOS header in ${filename}`);
  }
  const pe = bytes.readUInt32LE(0x3c);
  if (pe > bytes.length - 6 || bytes.readUInt32LE(pe) !== 0x00004550) {
    throw new Error(`Missing PE header in ${filename}`);
  }
  const machine = bytes.readUInt16LE(pe + 4);
  if (machine !== 0x8664) throw new Error(`${filename} has PE machine 0x${machine.toString(16)}, expected Windows x64`);
}
