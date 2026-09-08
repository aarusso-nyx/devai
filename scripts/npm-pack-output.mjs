// npm <=11 returns an array; npm 12 returns an object keyed by package name.
// Both representations must describe exactly the requested package.
export function npmPackOutput(value, expected) {
  const refuse = () => {
    throw new Error('RELEASE_PACK_OUTPUT_INVALID');
  };
  let entry;
  if (Array.isArray(value)) {
    if (value.length !== 1) refuse();
    [entry] = value;
  } else {
    if (value === null || typeof value !== 'object') refuse();
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== expected.name) refuse();
    entry = value[keys[0]];
  }
  if (
    entry === null ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    entry.name !== expected.name ||
    entry.version !== expected.version ||
    typeof entry.filename !== 'string' ||
    !/^[^/\\\0]+\.tgz$/u.test(entry.filename) ||
    !Array.isArray(entry.files) ||
    entry.files.length === 0 ||
    entry.files.some(
      (file) =>
        file === null ||
        typeof file !== 'object' ||
        typeof file.path !== 'string' ||
        file.path.length === 0,
    ) ||
    new Set(entry.files.map((file) => file.path)).size !== entry.files.length
  )
    refuse();
  return entry;
}
