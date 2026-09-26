const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Exercise the TypeScript directly without requiring Rollup's browser-only loaders.
function loadTS(relativePath, imports = {}) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      jsxFactory: 'h',
    },
  }).outputText;
  const exports = {};
  const localRequire = (name) => {
    if (Object.prototype.hasOwnProperty.call(imports, name))
      return imports[name];
    if (name.includes('.css') || name.startsWith('url:')) return {};
    throw Error(`Unexpected dependency: ${name}`);
  };
  new Function('require', 'exports', code)(localRequire, exports);
  return exports;
}
const files = loadTS('src/client/lazy-app/Batch/files.ts');
const naming = {
  enabled: true,
  prefix: '',
  suffix: '-compressed',
  numbered: false,
};

test('download names handle duplicate stems, case, Unicode, paths and extensionless files', () => {
  const names = files.outputNames(
    [
      { file: { name: 'photo.jpg' } },
      { file: { name: 'photo.png' } },
      { file: { name: 'PHOTO.avif' } },
      { file: { name: 'ภาพ' } },
      { file: { name: 'other.png' }, customName: '../folder/name' },
    ],
    'webp',
    naming,
  );
  assert.deepEqual(names, [
    'photo-compressed.webp',
    'photo-compressed (2).webp',
    'PHOTO-compressed (3).webp',
    'ภาพ-compressed.webp',
    '.._folder_name.webp',
  ]);
  assert.equal(
    new Set(names.map((name) => name.toLowerCase())).size,
    names.length,
  );
  assert.equal(files.safeName('...'), 'image');
});

test('original format and custom stems coexist with sequence naming', () => {
  assert.deepEqual(
    files.outputNames(
      [
        { file: { name: 'one.jpg' } },
        { file: { name: 'two.png' }, customName: 'hero' },
      ],
      undefined,
      { ...naming, prefix: 'site-', numbered: true },
    ),
    ['site-one-compressed-001.jpg', 'hero.png'],
  );
});

test('ZIP contains standard CRC-32, UTF-8 names, payloads and central-directory offsets', async () => {
  const zip = await files.createZip([
    { name: 'ภาพ.webp', blob: new Blob(['123456789']) },
    { name: 'empty.png', blob: new Blob([]) },
  ]);
  assert.equal(zip.type, 'application/zip');
  const buffer = Buffer.from(await zip.arrayBuffer());
  assert.equal(buffer.readUInt32LE(0), 0x04034b50);
  assert.equal(buffer.readUInt16LE(6), 0x800);
  assert.equal(buffer.readUInt32LE(14), 0xcbf43926);
  const nameLength = buffer.readUInt16LE(26);
  assert.equal(buffer.subarray(30, 30 + nameLength).toString(), 'ภาพ.webp');
  assert.equal(
    buffer.subarray(30 + nameLength, 39 + nameLength).toString(),
    '123456789',
  );
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  assert.equal(buffer.readUInt16LE(end + 10), 2);
  const centralOffset = buffer.readUInt32LE(end + 16);
  assert.equal(buffer.readUInt32LE(centralOffset), 0x02014b50);
  assert.equal(buffer.readUInt32LE(centralOffset + 42), 0);
});

test('oversized ZIPs fail explicitly instead of producing corrupt downloads', async () => {
  await assert.rejects(
    files.createZip([{ name: 'large.webp', blob: { size: 0xffffffff } }]),
    /4 GB/,
  );
  await assert.rejects(
    files.createZip(Array(65536).fill({})),
    /Too many files/,
  );
});

function makeBatch() {
  const captured = [];
  const meta = {
    encoderMap: { webP: { meta: { defaultOptions: {}, extension: 'webp' } } },
    defaultProcessorState: {
      resize: {
        enabled: false,
        width: 1,
        height: 1,
        method: 'lanczos3',
        fitMethod: 'stretch',
      },
      quantize: { enabled: false },
    },
    defaultPreprocessorState: { rotate: { rotate: 0 } },
  };
  const pipeline = {
    preprocessImage: async (_, image, settings) =>
      settings.rotate.rotate % 180
        ? { width: image.height, height: image.width }
        : image,
    processImage: async (_, source, processors) => {
      captured.push(processors);
      return source.preprocessed;
    },
    compressImage: async (_, image, encoder, name) => {
      if (name === 'broken.png') throw Error('Invalid image');
      return new File(['encoded'], name, { type: 'image/webp' });
    },
  };
  const { default: Batch } = loadTS('src/client/lazy-app/Batch/index.tsx', {
    preact: require('preact'),
    '../Compress/Options': {},
    '../feature-meta': meta,
    '../image-pipeline': pipeline,
    '../util/canvas': {},
    '../util': {
      assertSignal(signal) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      },
    },
    '../worker-bridge': { default: class {} },
    '../Compress/Results/pretty-bytes': {},
    './files': files,
  });
  const batch = new Batch({
    incoming: [],
    showSnack: () => Promise.resolve(''),
    onInspect() {},
    onClassic() {},
  });
  batch.setState = function (update) {
    this.state = {
      ...this.state,
      ...(typeof update === 'function'
        ? update(this.state, this.props)
        : update),
    };
  };
  batch.readSource = async (file) => {
    const decoded =
      file.name === 'portrait.png'
        ? { width: 100, height: 200 }
        : { width: 200, height: 100 };
    return { file, decoded, preprocessed: decoded };
  };
  batch.state.items = ['landscape.png', 'broken.png', 'portrait.png'].map(
    (name, id) => {
      const file = new File(['original image bytes'], name, {
        type: 'image/png',
      });
      return {
        id,
        file,
        thumbnail: URL.createObjectURL(file),
        status: 'pending',
      };
    },
  );
  return { batch, pipeline, captured };
}

test('queue continues after failures, retries only unfinished items and invalidates old output', async () => {
  const { batch } = makeBatch();
  try {
    await batch.run();
    assert.deepEqual(
      batch.state.items.map((item) => item.status),
      ['done', 'error', 'done'],
    );
    const firstResult = batch.state.items[0].result;
    await batch.run();
    assert.equal(batch.state.items[0].result, firstResult);
    assert.equal(batch.state.items[1].error, 'Invalid image');
    batch.invalidate({ rotation: 90 });
    assert.ok(
      batch.state.items.every(
        (item) => item.status === 'pending' && !item.url && !item.result,
      ),
    );
    assert.equal(batch.state.rotation, 90);
  } finally {
    batch.componentWillUnmount();
  }
});

test('cancel returns current work to pending, and resumed work finishes', async () => {
  const { batch, pipeline } = makeBatch();
  let started;
  const encoding = new Promise((resolve) => {
    started = resolve;
  });
  const originalEncode = pipeline.compressImage;
  pipeline.compressImage = async (signal) => {
    started();
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      ),
    );
  };
  try {
    const running = batch.run();
    await encoding;
    batch.controller.abort();
    await running;
    assert.ok(batch.state.items.every((item) => item.status === 'pending'));
    assert.equal(batch.state.running, false);
    pipeline.compressImage = originalEncode;
    await batch.run();
    assert.deepEqual(
      batch.state.items.map((item) => item.status),
      ['done', 'error', 'done'],
    );
  } finally {
    batch.componentWillUnmount();
  }
});

test('mixed image aspect ratios fit individually, and rotation precedes resize', async () => {
  const { batch, captured } = makeBatch();
  try {
    batch.state.processors.resize = {
      ...batch.state.processors.resize,
      enabled: true,
      width: 50,
      height: 50,
    };
    batch.state.rotation = 90;
    // Fit must ignore a crop setting restored from the original editor.
    batch.state.processors.resize.fitMethod = 'contain';
    await batch.run();
    assert.deepEqual(
      captured.map((processors) => [
        processors.resize.width,
        processors.resize.height,
      ]),
      [
        [25, 50],
        [25, 50],
        [50, 25],
      ],
    );
    assert.ok(captured.every(({ resize }) => resize.fitMethod === 'stretch'));
  } finally {
    batch.componentWillUnmount();
  }
});

for (const fit of ['fill', 'stretch']) {
  test(`${fit} keeps exact dimensions and selects the appropriate resize behavior`, async () => {
    const { batch, captured } = makeBatch();
    try {
      batch.state.resizeFit = fit;
      batch.state.processors.resize = {
        ...batch.state.processors.resize,
        enabled: true,
        width: 50,
        height: 50,
      };
      await batch.run();
      assert.deepEqual(
        captured.map(({ resize }) => [
          resize.width,
          resize.height,
          resize.fitMethod,
        ]),
        Array(3).fill([50, 50, fit === 'fill' ? 'contain' : 'stretch']),
      );
    } finally {
      batch.componentWillUnmount();
    }
  });
}

test('saved fit methods round-trip and legacy aspect settings retain their behavior', () => {
  const { batch } = makeBatch();
  const previousStorage = global.localStorage;
  let saved;
  global.localStorage = {
    setItem(_, value) {
      saved = value;
    },
    getItem() {
      return saved;
    },
  };
  try {
    batch.state.resizeFit = 'fill';
    batch.saveSettings();
    batch.state.resizeFit = 'fit';
    batch.restoreSettings();
    assert.equal(batch.state.resizeFit, 'fill');
    const data = JSON.parse(saved);
    delete data.resizeFit;
    for (const [preserveAspect, originalMode, expected] of [
      [true, 'contain', 'fit'],
      [false, 'contain', 'fill'],
      [false, 'stretch', 'stretch'],
    ]) {
      saved = JSON.stringify({
        ...data,
        preserveAspect,
        processors: {
          ...data.processors,
          resize: { ...data.processors.resize, fitMethod: originalMode },
        },
      });
      batch.restoreSettings();
      assert.equal(batch.state.resizeFit, expected);
    }
  } finally {
    global.localStorage = previousStorage;
    batch.componentWillUnmount();
  }
});

test('original output preserves bytes and does not run processing', async () => {
  const { batch, captured } = makeBatch();
  try {
    batch.state.encoder = undefined;
    await batch.run();
    assert.ok(
      batch.state.items.every(
        (item) => item.result === item.file && item.status === 'done',
      ),
    );
    assert.equal(captured.length, 0);
  } finally {
    batch.componentWillUnmount();
  }
});
