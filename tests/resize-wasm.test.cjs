const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

// Node has no ImageData. This shim validates the same RGBA buffer dimensions;
// the decoding, resizing and encoding below run the actual bundled WASM.
global.ImageData = class ImageData {
  constructor(data, width, height) {
    assert.equal(data.length, width * height * 4);
    assert.ok(width > 0 && height > 0);
    Object.assign(this, { data, width, height });
  }
};

function loadTS(relativePath, imports) {
  const code = ts.transpileModule(
    fs.readFileSync(path.join(root, relativePath), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText;
  const exports = {};
  new Function('require', 'exports', code)((name) => {
    assert.ok(name in imports, `Unexpected dependency: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}

async function loadCodec(directory, name) {
  const source = fs.readFileSync(
    path.join(root, directory, `${name}.js`),
    'utf8',
  );
  const api = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  const wasmBytes = fs.readFileSync(
    path.join(root, directory, `${name}_bg.wasm`),
  );
  return { api, wasmBytes };
}

async function makeResizer() {
  const { api, wasmBytes } = await loadCodec(
    'codecs/resize/pkg',
    'squoosh_resize',
  );
  const modules = [];
  let memory;
  const init = async (input) => {
    const instance = await api.default(input || wasmBytes);
    memory = instance.memory;
    modules.push(api.default.__wbindgen_wasm_module);
    return instance;
  };
  Object.defineProperty(init, '__wbindgen_wasm_module', {
    get: () => api.default.__wbindgen_wasm_module,
  });
  const resize = loadTS('src/features/processors/resize/worker/resize.ts', {
    '../shared/util': loadTS(
      'src/features/processors/resize/shared/util.ts',
      {},
    ),
    'codecs/resize/pkg': { default: init, resize: api.resize },
    'codecs/hqx/pkg': {}, // These tests select Lanczos3, not hqx.
  }).default;
  return { resize, modules, memoryBytes: () => memory.buffer.byteLength };
}

const options = {
  width: 128,
  height: 128,
  method: 'lanczos3',
  fitMethod: 'stretch',
  premultiply: true,
  linearRGB: true,
};

test('real resizer bounds retained WASM memory and reuses compiled code across a batch', async () => {
  const resizer = await makeResizer();
  const pixel = [220, 80, 40, 255];
  let peakMemory = 0;
  for (let index = 0; index < 40; index++) {
    const width = 1000 + index * 3;
    const height = 900 + index * 2;
    const pixels = new Uint8ClampedArray(width * height * 4);
    new Uint32Array(pixels.buffer).fill(0xff2850dc);
    const output = await resizer.resize(
      new ImageData(pixels, width, height),
      options,
    );
    assert.deepEqual([output.width, output.height], [128, 128]);
    for (let channel = 0; channel < 4; channel++) {
      assert.ok(Math.abs(output.data[channel] - pixel[channel]) <= 1);
    }
    peakMemory = Math.max(peakMemory, resizer.memoryBytes());
  }
  assert.ok(
    resizer.modules.length > 1,
    'large batches must recycle the resize instance',
  );
  assert.ok(
    resizer.modules.every((module) => module === resizer.modules[0]),
    'compiled code is reused, not fetched and recompiled',
  );
  assert.ok(
    peakMemory < 192 * 1024 * 1024,
    `Retained memory grew to ${peakMemory} bytes`,
  );
});

test(
  'provided PNG corpus converts with 128×128 Fit and OxiPNG',
  {
    skip:
      !process.env.SQUOOSH_TEST_ITEMS &&
      'Set SQUOOSH_TEST_ITEMS to run the local image corpus',
  },
  async () => {
    const directory = path.resolve(process.env.SQUOOSH_TEST_ITEMS);
    const names = fs
      .readdirSync(directory)
      .filter((name) => /\.png$/i.test(name))
      .sort();
    assert.ok(names.length > 0);
    const png = await loadCodec('codecs/png/pkg', 'squoosh_png');
    await png.api.default(png.wasmBytes);
    const oxi = await loadCodec('codecs/oxipng/pkg', 'squoosh_oxipng');
    await oxi.api.default(oxi.wasmBytes);
    const resizer = await makeResizer();
    let totalBytes = 0;
    let peakMemory = 0;
    for (const name of names) {
      try {
        const input = png.api.decode(
          fs.readFileSync(path.join(directory, name)),
        );
        const ratio = Math.min(128 / input.width, 128 / input.height);
        const width = Math.max(1, Math.round(input.width * ratio));
        const height = Math.max(1, Math.round(input.height * ratio));
        const resized = await resizer.resize(input, {
          ...options,
          width,
          height,
        });
        const encoded = oxi.api.optimise(resized.data, width, height, 2, false);
        const decoded = png.api.decode(encoded);
        assert.deepEqual([decoded.width, decoded.height], [width, height]);
        for (let index = 0; index < resized.data.length; index += 4) {
          assert.equal(
            decoded.data[index + 3],
            resized.data[index + 3],
            `${name}: alpha changed`,
          );
          if (resized.data[index + 3]) {
            for (let channel = 0; channel < 3; channel++) {
              assert.equal(
                decoded.data[index + channel],
                resized.data[index + channel],
                `${name}: visible color changed`,
              );
            }
          }
        }
        totalBytes += encoded.length;
        peakMemory = Math.max(peakMemory, resizer.memoryBytes());
      } catch (error) {
        throw Error(`${name}: ${error.message}`, { cause: error });
      }
    }
    console.log(
      `Verified ${
        names.length
      } PNGs; output ${totalBytes} bytes; resize memory peaked at ${(
        peakMemory / 1048576
      ).toFixed(1)} MiB.`,
    );
  },
);
