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
