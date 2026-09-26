import { h, Component, createRef } from 'preact';
import * as style from './style.css';
import 'add-css:./style.css';
import Options from '../Compress/Options';
import type { SourceImage, OutputType } from '../Compress';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import {
  encoderMap,
  EncoderState,
  EncoderOptions,
  ProcessorState,
  defaultProcessorState,
  defaultPreprocessorState,
} from '../feature-meta';
import {
  decodeImage,
  processSvg,
  preprocessImage,
  processImage,
  compressImage,
} from '../image-pipeline';
import { drawableToImageData } from '../util/canvas';
import { assertSignal } from '../util';
import WorkerBridge from '../worker-bridge';
import prettyBytes from '../Compress/Results/pretty-bytes';
import { createZip, outputNames } from './files';
import samplePhoto from 'url:shared/prerendered-app/Intro/imgs/demos/demo-artwork.jpg';
import sampleScreen from 'url:shared/prerendered-app/Intro/imgs/demos/demo-device-screen.png';

interface Item {
  id: number;
  file: File;
  thumbnail: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  result?: File;
  url?: string;
  error?: string;
  customName?: string;
}
interface Props {
  incoming: File[];
  onInspect(file: File): void;
  onClassic(): void;
  showSnack: SnackBarElement['showSnackbar'];
}
interface State {
  items: Item[];
  encoder?: EncoderState;
  processors: ProcessorState;
  source?: SourceImage;
  rotation: 0 | 90 | 180 | 270;
  running: boolean;
  zipping: boolean;
  naming: {
    enabled: boolean;
    prefix: string;
    suffix: string;
    numbered: boolean;
  };
  resizeFit: 'fit' | 'fill' | 'stretch';
  filter: 'all' | 'done' | 'error';
  samplesLoading: boolean;
}
const bytes = (size: number) => {
  const b = prettyBytes(size);
  return `${b.value} ${b.unit}`;
};
const ignore = () => {};

function Icon({ name }: { name: 'upload' | 'download' | 'image' | 'close' }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {name === 'upload' ? (
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" />
      ) : name === 'download' ? (
        <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />
      ) : name === 'close' ? (
        <path d="m6 6 12 12M6 18 18 6" />
      ) : (
        <g>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="8" cy="8" r="1" />
          <path d="m3 17 6-6 4 4 3-3 5 5" />
        </g>
      )}
    </svg>
  );
}

export default class Batch extends Component<Props, State> {
  state: State = {
    items: [],
    encoder: {
      type: 'webP',
      options: { ...encoderMap.webP.meta.defaultOptions },
    },
    processors: {
      ...defaultProcessorState,
      resize: { ...defaultProcessorState.resize, width: 1920, height: 1080 },
    },
    rotation: 0,
    running: false,
    zipping: false,
    naming: {
      enabled: true,
      prefix: '',
      suffix: '-compressed',
      numbered: false,
    },
    resizeFit: 'fit',
    filter: 'all',
    samplesLoading: false,
  };
  private picker = createRef<HTMLInputElement>();
  private nextId = 1;
  private worker = new WorkerBridge();
  private controller?: AbortController;
  private previewController?: AbortController;
  private previewWorker = new WorkerBridge();
  private alive = true;
  private busy = false;

  componentDidMount() {
    this.addFiles(this.props.incoming);
    import('../sw-bridge').then(({ mainAppLoaded }) => mainAppLoaded());
  }
  componentDidUpdate(previous: Props) {
    if (previous.incoming !== this.props.incoming)
      this.addFiles(this.props.incoming);
  }
  componentWillUnmount() {
    this.alive = false;
    this.controller?.abort();
    this.previewController?.abort();
    this.state.items.forEach(this.release);
  }
  private release = (item: Item) => {
    URL.revokeObjectURL(item.thumbnail);
    if (item.url) URL.revokeObjectURL(item.url);
  };
  private addFiles = (files: File[]) => {
    if (!files.length) return;
    const accepted = files.filter(
      (file) =>
        file.type.startsWith('image/') ||
        /\.(avif|webp|wp2|jxl|qoi|png|jpe?g|gif|bmp|svg|ico)$/i.test(file.name),
    );
    if (accepted.length !== files.length)
      this.props.showSnack(
        'Some files were skipped because they are not supported images.',
      );
    if (!accepted.length) return;
    const items: Item[] = accepted.map((file) => ({
      id: this.nextId++,
      file,
      thumbnail: URL.createObjectURL(file),
      status: 'pending',
    }));
    const first = !this.state.items.length;
    this.setState((state) => ({
      items: [...state.items, ...items],
      filter: 'all',
    }));
    if (first) this.loadPreview(accepted[0]);
  };
  private readSource = async (
    file: File,
    signal: AbortSignal,
    worker: WorkerBridge,
  ): Promise<SourceImage> => {
    const vectorImage =
      file.type.startsWith('image/svg+xml') || /\.svg$/i.test(file.name)
        ? await processSvg(signal, file)
        : undefined;
    const decoded = vectorImage
      ? drawableToImageData(vectorImage)
      : await decodeImage(signal, file, worker);
    assertSignal(signal);
    return { file, decoded, preprocessed: decoded, vectorImage };
  };
  private loadPreview = async (file?: File) => {
    this.previewController?.abort();
    this.setState({ source: undefined });
    if (!file) return;
    const controller = (this.previewController = new AbortController());
    try {
      const source = await this.readSource(
        file,
        controller.signal,
        this.previewWorker,
      );
      if (this.alive && !controller.signal.aborted)
        this.setState((state) => ({
          source,
          processors: state.processors.resize.enabled
            ? state.processors
            : {
                ...state.processors,
                resize: {
                  ...state.processors.resize,
                  width: source.decoded.width,
                  height: source.decoded.height,
                },
              },
        }));
    } catch (_) {
      /* The queue reports decode errors for each file during conversion. */
    }
  };
  private pickFiles = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    this.addFiles(Array.from(input.files || []));
    input.value = '';
  };
  private addSamples = async () => {
    if (this.state.samplesLoading) return;
    this.setState({ samplesLoading: true });
    try {
      const files = await Promise.all(
        [
          [samplePhoto, 'sample-artwork.jpg'],
          [sampleScreen, 'sample-screen.png'],
        ].map(async ([url, name]) => {
          const response = await fetch(url);
          if (!response.ok) throw Error('Sample unavailable');
          const blob = await response.blob();
          return new File([blob], name, { type: blob.type });
        }),
      );
      if (this.alive) this.addFiles(files);
    } catch (_) {
      this.props.showSnack(
        'Could not load sample images. Try adding your own files.',
      );
    } finally {
      if (this.alive) this.setState({ samplesLoading: false });
    }
  };
  private invalidate = (changes: Partial<State>) => {
    if (this.busy) return;
    this.setState((state) => ({
      ...changes,
      items: state.items.map((item) => {
        if (item.url) URL.revokeObjectURL(item.url);
        return {
          ...item,
          status: 'pending',
          result: undefined,
          url: undefined,
          error: undefined,
        };
      }),
    }));
  };
  private changeEncoder = (_: 0 | 1, type: OutputType) => {
    this.invalidate({
      encoder:
        type === 'identity'
          ? undefined
          : ({
              type,
              options: { ...encoderMap[type].meta.defaultOptions },
            } as EncoderState),
    });
  };
  private changeOptions = (_: 0 | 1, options: EncoderOptions) => {
    if (this.state.encoder)
      this.invalidate({
        encoder: { ...this.state.encoder, options } as EncoderState,
      });
  };
  private changeProcessors = (_: 0 | 1, processors: ProcessorState) =>
    this.invalidate({ processors });
  private updateItem = (id: number, changes: Partial<Item>) => {
    if (this.alive)
      this.setState((state) => ({
        items: state.items.map((item) =>
          item.id === id ? { ...item, ...changes } : item,
        ),
      }));
  };
  private remove = (item: Item) => {
    if (this.busy) return;
    this.release(item);
    const items = this.state.items.filter((other) => other.id !== item.id);
    this.setState({ items });
    if (this.state.items[0]?.id === item.id) this.loadPreview(items[0]?.file);
  };
  private clear = () => {
    if (this.busy) return;
    this.state.items.forEach(this.release);
    this.previewController?.abort();
    this.setState({ items: [], source: undefined, filter: 'all' });
  };
  private run = async () => {
    if (this.busy) return;
    this.busy = true;
    const controller = (this.controller = new AbortController());
    const { signal } = controller;
    const { encoder, processors, rotation, resizeFit } = this.state;
    const queue = this.state.items.filter((item) => item.status !== 'done');
    this.setState({ running: true, filter: 'all' });
    try {
      for (const item of queue) {
        if (signal.aborted) break;
        this.updateItem(item.id, { status: 'processing', error: undefined });
        try {
          let result: File;
          if (!encoder) {
            result = item.file;
          } else {
            const source = await this.readSource(
              item.file,
              signal,
              this.worker,
            );
            source.preprocessed = await preprocessImage(
              signal,
              source.decoded,
              {
                ...defaultPreprocessorState,
                rotate: { rotate: rotation },
              },
              this.worker,
            );
            let resize = { ...processors.resize };
            // The original resize pipeline calls its centered crop mode "contain".
            resize.fitMethod = resizeFit === 'fill' ? 'contain' : 'stretch';
            // Fit each image inside the target box without stretching mixed aspect ratios.
            if (resize.enabled && resizeFit === 'fit') {
              const ratio = Math.min(
                resize.width / source.preprocessed.width,
                resize.height / source.preprocessed.height,
              );
              resize.width = Math.max(
                1,
                Math.round(source.preprocessed.width * ratio),
              );
              resize.height = Math.max(
                1,
                Math.round(source.preprocessed.height * ratio),
              );
            }
            if (
              resize.enabled &&
              (!Number.isFinite(resize.width) ||
                !Number.isFinite(resize.height) ||
                resize.width < 1 ||
                resize.height < 1)
            )
              throw Error('Resize dimensions must be positive numbers.');
            // A mixed queue can contain raster images even when vector resize was selected.
            if (
              resize.method === 'vector' &&
              (!source.vectorImage || rotation !== 0)
            )
              resize = {
                ...resize,
                method: 'lanczos3',
                premultiply: true,
                linearRGB: true,
              };
            const processed = await processImage(
              signal,
              source,
              { ...processors, resize },
              this.worker,
            );
            result = await compressImage(
              signal,
              processed,
              encoder,
              item.file.name,
              this.worker,
            );
          }
          assertSignal(signal);
          this.updateItem(item.id, {
            result,
            url: URL.createObjectURL(result),
            status: 'done',
          });
        } catch (error) {
          if (signal.aborted) {
            this.updateItem(item.id, { status: 'pending' });
            break;
          }
          this.updateItem(item.id, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.busy = false;
      if (this.alive) this.setState({ running: false });
    }
  };
  private downloadZip = async () => {
    if (this.state.zipping) return;
    this.setState({ zipping: true });
    try {
      const names = this.names();
      const entries = this.state.items.flatMap((item, index) =>
        item.result ? [{ name: names[index], blob: item.result }] : [],
      );
      const blob = await createZip(entries);
      if (!this.alive) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'squoosh-images.zip';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      this.props.showSnack(
        `ZIP download failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      if (this.alive) this.setState({ zipping: false });
    }
  };
  private names = () =>
    outputNames(
      this.state.items,
      this.state.encoder
        ? encoderMap[this.state.encoder.type].meta.extension
        : undefined,
      this.state.naming,
    );
  private saveSettings = () => {
    const { encoder, processors, rotation, naming, resizeFit } = this.state;
    try {
      localStorage.setItem(
        'squoosh-batch-settings',
        JSON.stringify({
          encoder,
          processors,
          rotation,
          naming,
          resizeFit,
        }),
      );
      this.props.showSnack('Batch settings saved on this device.');
    } catch (_) {
      this.props.showSnack('Your browser could not save these settings.');
    }
  };
  private restoreSettings = () => {
    try {
      const saved = localStorage.getItem('squoosh-batch-settings');
      if (!saved) {
        this.props.showSnack('No saved batch settings yet.');
        return;
      }
      const data = JSON.parse(saved);
      if (
        !data.processors?.resize ||
        !data.processors?.quantize ||
        ![0, 90, 180, 270].includes(data.rotation) ||
        (data.encoder &&
          !encoderMap[data.encoder.type as keyof typeof encoderMap]) ||
        !data.naming ||
        typeof data.naming.prefix !== 'string' ||
        typeof data.naming.suffix !== 'string'
      )
        throw Error('Invalid settings');
      this.invalidate({
        encoder: data.encoder,
        processors: data.processors,
        rotation: data.rotation,
        naming: data.naming,
        resizeFit: ['fit', 'fill', 'stretch'].includes(data.resizeFit)
          ? data.resizeFit
          : data.preserveAspect
          ? 'fit'
          : data.processors.resize.fitMethod === 'contain'
          ? 'fill'
          : 'stretch',
      });
      this.props.showSnack('Saved batch settings restored.');
    } catch (_) {
      this.props.showSnack('Saved batch settings could not be restored.');
    }
  };

  render(_: Props, state: State) {
    const {
      items,
      encoder,
      processors,
      running,
      naming,
      source,
      filter,
      zipping,
    } = state;
    const names = this.names();
    const done = items.filter((item) => item.status === 'done');
    const errors = items.filter((item) => item.status === 'error').length;
    const originalTotal = items.reduce((sum, item) => sum + item.file.size, 0);
    const compressedTotal = done.reduce(
      (sum, item) => sum + item.result!.size,
      0,
    );
    const completedOriginal = done.reduce(
      (sum, item) => sum + item.file.size,
      0,
    );
    const saving = completedOriginal
      ? (1 - compressedTotal / completedOriginal) * 100
      : 0;
    const shown = items.filter(
      (item) => filter === 'all' || item.status === filter,
    );
    return (
      <main class={style.workspace}>
        <input
          ref={this.picker}
          class={style.hiddenInput}
          type="file"
          multiple
          accept="image/*,.jxl,.wp2,.qoi"
          onChange={this.pickFiles}
          aria-label="Choose images"
        />
        <header class={style.header}>
          <a
            class={style.brand}
            href="/"
            onClick={(event) => event.preventDefault()}
          >
            <span class={style.brandMark}>s.</span> squoosh{' '}
            <span class={style.batchBadge}>BATCH</span>
          </a>
          <div class={style.headerRight}>
            <span class={style.localNote}>
              <i /> Files stay on your device
            </span>
            <button
              class={style.quietButton}
              disabled={running}
              onClick={this.props.onClassic}
            >
              Single image editor ↗
            </button>
          </div>
        </header>
        <div class={style.content}>
          <div class={style.heading}>
            <div>
              <div class={style.eyebrow}>LESS WEIGHT. SAME POSSIBILITIES.</div>
              <h1>Good things come in batches.</h1>
              <p>All the power of Squoosh. Every image, in one place.</p>
            </div>
            <button
              class={style.primaryButton}
              onClick={() => this.picker.current?.click()}
            >
              <Icon name="upload" /> Add images
            </button>
          </div>
          <button
            class={style.dropzone}
            onClick={() => this.picker.current?.click()}
          >
            <span class={style.uploadIcon}>
              <Icon name="upload" />
            </span>
            <span>
              <strong>
                Drop your images here <span>or browse files</span>
              </strong>
              <small>
                JPG, PNG, WebP, AVIF, SVG and more · Multiple files welcome
              </small>
            </span>
            <span class={style.dropHint}>100% local processing</span>
          </button>
          <div class={style.layout}>
            <aside class={style.sidebar} aria-label="Batch encoding settings">
              <div class={style.panelHeading}>
                <h2>Encoding settings</h2>
                <span>APPLIES TO ALL</span>
              </div>
              <fieldset disabled={running} class={style.settings}>
                <Options
                  bulk
                  index={1}
                  mobileView={false}
                  source={source}
                  processorState={processors}
                  encoderState={encoder}
                  onEncoderTypeChange={this.changeEncoder}
                  onEncoderOptionsChange={this.changeOptions}
                  onProcessorOptionsChange={this.changeProcessors}
                  onCopyToOtherSideClick={ignore}
                  onSaveSideSettingsClick={ignore}
                  onImportSideSettingsClick={ignore}
                />
                {encoder && (
                  <div class={style.extraSettings}>
                    {processors.resize.enabled && (
                      <div>
                        <label class={style.fieldLabel}>
                          Fit method:
                          <select
                            value={state.resizeFit}
                            onChange={(event) =>
                              this.invalidate({
                                resizeFit: event.currentTarget
                                  .value as State['resizeFit'],
                              })
                            }
                          >
                            <option value="fill">Fill</option>
                            <option value="fit">Fit</option>
                            <option value="stretch">Stretch</option>
                          </select>
                        </label>
                        <p class={style.help}>
                          {state.resizeFit === 'fill'
                            ? 'Fills the target dimensions while preserving aspect ratio. Edges are cropped from the center.'
                            : state.resizeFit === 'fit'
                            ? 'Fits the whole image inside the target dimensions while preserving aspect ratio. No cropping.'
                            : 'Uses the exact target dimensions. Images may be stretched.'}
                        </p>
                      </div>
                    )}
                    <label class={style.fieldLabel}>
                      Rotation
                      <select
                        value={state.rotation}
                        onChange={(event) =>
                          this.invalidate({
                            rotation: Number(
                              event.currentTarget.value,
                            ) as State['rotation'],
                          })
                        }
                      >
                        <option value="0">No rotation</option>
                        <option value="90">90° clockwise</option>
                        <option value="180">180°</option>
                        <option value="270">270° clockwise</option>
                      </select>
                    </label>
                  </div>
                )}
                <details class={style.naming} open>
                  <summary>
                    Batch renaming <span>↗</span>
                  </summary>
                  <label class={style.checkLabel}>
                    <input
                      type="checkbox"
                      checked={naming.enabled}
                      onChange={(event) =>
                        this.setState({
                          naming: {
                            ...naming,
                            enabled: event.currentTarget.checked,
                          },
                        })
                      }
                    />{' '}
                    Enable batch renaming
                  </label>
                  {naming.enabled && (
                    <div class={style.namingFields}>
                      <label class={style.fieldLabel}>
                        Prefix
                        <input
                          value={naming.prefix}
                          placeholder="e.g. website-"
                          onInput={(event) =>
                            this.setState({
                              naming: {
                                ...naming,
                                prefix: event.currentTarget.value,
                              },
                            })
                          }
                        />
                      </label>
                      <label class={style.fieldLabel}>
                        Suffix
                        <input
                          value={naming.suffix}
                          onInput={(event) =>
                            this.setState({
                              naming: {
                                ...naming,
                                suffix: event.currentTarget.value,
                              },
                            })
                          }
                        />
                      </label>
                      <label class={style.checkLabel}>
                        <input
                          type="checkbox"
                          checked={naming.numbered}
                          onChange={(event) =>
                            this.setState({
                              naming: {
                                ...naming,
                                numbered: event.currentTarget.checked,
                              },
                            })
                          }
                        />{' '}
                        Add sequence numbers
                      </label>
                    </div>
                  )}
                </details>
                <div class={style.settingsActions}>
                  <button onClick={this.saveSettings}>Save settings</button>
                  <button onClick={this.restoreSettings}>
                    Restore settings
                  </button>
                </div>
              </fieldset>
              <p class={style.sidebarFoot}>
                Original codecs. Every advanced option.
                <br />
                Open originals in the full comparison editor.
              </p>
            </aside>
            <section
              class={style.queueSection}
              aria-label="Image conversion queue"
            >
              <div class={style.stats}>
                <div>
                  <span>ORIGINAL TOTAL</span>
                  <strong>{bytes(originalTotal)}</strong>
                  <small>
                    {items.length} {items.length === 1 ? 'image' : 'images'} in
                    queue
                  </small>
                </div>
                <div>
                  <span>COMPRESSED TOTAL</span>
                  <strong>{done.length ? bytes(compressedTotal) : '—'}</strong>
                  <small>
                    {done.length} of {items.length} completed
                  </small>
                </div>
                <div>
                  <span>{saving < 0 ? 'SIZE INCREASE' : 'SPACE SAVED'}</span>
                  <strong class={saving < 0 ? style.warning : style.savings}>
                    {done.length ? `${Math.abs(saving).toFixed(1)}%` : '—'}
                  </strong>
                  <small>
                    {done.length
                      ? `${bytes(
                          Math.abs(completedOriginal - compressedTotal),
                        )} ${saving < 0 ? 'larger' : 'saved'}`
                      : 'Ready when you are'}
                  </small>
                </div>
              </div>
              <div class={style.toolbar}>
                <div>
                  <h2>
                    Your images <span>{items.length}</span>
                  </h2>
                  <p aria-live="polite">
                    {running
                      ? `Converting ${Math.min(
                          done.length + errors + 1,
                          items.length,
                        )} of ${items.length}…`
                      : errors
                      ? `${errors} failed · Fix settings or retry`
                      : done.length === items.length && items.length
                      ? 'All done. Looking lighter already.'
                      : 'One set of settings. A whole batch of possibilities.'}
                  </p>
                </div>
                <div class={style.actions}>
                  <button
                    class={style.quietButton}
                    disabled={!items.length || running || zipping}
                    onClick={this.clear}
                  >
                    Clear list
                  </button>
                  <button
                    class={style.secondaryButton}
                    disabled={!done.length || zipping}
                    onClick={this.downloadZip}
                  >
                    <Icon name="download" />
                    {zipping
                      ? 'Creating ZIP…'
                      : `Download ZIP (${done.length})`}
                  </button>
                  {running ? (
                    <button
                      class={style.primaryButton}
                      onClick={() => this.controller?.abort()}
                    >
                      Stop conversion
                    </button>
                  ) : (
                    <button
                      class={style.primaryButton}
                      disabled={!items.length || done.length === items.length}
                      onClick={this.run}
                    >
                      {errors
                        ? 'Retry unfinished'
                        : `Compress all${
                            items.length
                              ? ` (${items.length - done.length})`
                              : ''
                          }`}
                      <span>→</span>
                    </button>
                  )}
                </div>
              </div>
              {running && (
                <progress
                  class={style.progress}
                  max={items.length}
                  value={done.length + errors}
                  aria-label="Batch conversion progress"
                />
              )}
              <div class={style.queue}>
                <div class={style.queueHeader}>
                  <div class={style.filters}>
                    {(['all', 'done', 'error'] as const).map((value) => (
                      <button
                        class={filter === value ? style.activeFilter : ''}
                        onClick={() => this.setState({ filter: value })}
                      >
                        {value === 'all'
                          ? 'All files'
                          : value === 'done'
                          ? 'Completed'
                          : 'Failed'}
                        {value === 'error' && errors ? ` (${errors})` : ''}
                      </button>
                    ))}
                  </div>
                  <span>OUTPUT / STATUS</span>
                </div>
                {!items.length ? (
                  <div class={style.empty}>
                    <span class={style.emptyIcon}>
                      <Icon name="image" />
                    </span>
                    <h3>A lighter library starts here.</h3>
                    <p>
                      Add a few images or your whole collection.
                      <br />
                      We’ll take care of the heavy lifting.
                    </p>
                    <button
                      class={style.secondaryButton}
                      onClick={() => this.picker.current?.click()}
                    >
                      Choose images <span>↗</span>
                    </button>
                    <small>No uploads. No file leaves your browser.</small>
                    <button
                      class={style.sampleButton}
                      disabled={state.samplesLoading}
                      onClick={this.addSamples}
                    >
                      {state.samplesLoading
                        ? 'Loading samples…'
                        : 'Or try two sample images'}
                    </button>
                  </div>
                ) : !shown.length ? (
                  <div class={style.empty}>
                    <h3>
                      {filter === 'error'
                        ? 'No failed images.'
                        : 'No completed images yet.'}
                    </h3>
                    <p>
                      {filter === 'error'
                        ? 'Any conversion errors will appear here.'
                        : 'Start a conversion to see your results.'}
                    </p>
                  </div>
                ) : (
                  <ul class={style.fileList}>
                    {shown.map((item) => {
                      const name = names[items.indexOf(item)];
                      const percent =
                        item.result && item.file.size
                          ? Math.round(
                              (1 - item.result.size / item.file.size) * 100,
                            )
                          : 0;
                      return (
                        <li key={item.id} class={style.fileRow}>
                          <button
                            class={style.thumbnail}
                            disabled={running}
                            title={`Open ${item.file.name} in comparison editor`}
                            onClick={() => this.props.onInspect(item.file)}
                          >
                            <Icon name="image" />
                            <img
                              src={item.thumbnail}
                              alt=""
                              loading="lazy"
                              onError={(event) => {
                                event.currentTarget.style.display = 'none';
                              }}
                            />
                          </button>
                          <div class={style.fileInfo}>
                            <div class={style.nameLine}>
                              <input
                                class={style.filename}
                                aria-label={`Output name for ${item.file.name} (without extension)`}
                                value={
                                  item.customName ||
                                  name.replace(/\.[^.]+$/, '')
                                }
                                disabled={running}
                                onChange={(event) =>
                                  this.updateItem(item.id, {
                                    customName:
                                      event.currentTarget.value.trim() ||
                                      undefined,
                                  })
                                }
                              />
                              <span class={style.extension}>
                                .{name.split('.').pop()}
                              </span>
                            </div>
                            <div class={style.fileMeta}>
                              <span title={item.file.name}>
                                {item.file.name}
                              </span>
                              <span>{bytes(item.file.size)}</span>
                              {item.result && (
                                <span>→ {bytes(item.result.size)}</span>
                              )}
                              <button
                                disabled={running}
                                onClick={() => this.props.onInspect(item.file)}
                              >
                                Edit ↗
                              </button>
                            </div>
                            {item.error && (
                              <p class={style.errorText} role="alert">
                                {item.error}
                              </p>
                            )}
                          </div>
                          <div class={style.fileResult}>
                            {item.result && (
                              <span
                                class={
                                  percent >= 0 ? style.savings : style.warning
                                }
                              >
                                {percent >= 0 ? '−' : '+'}
                                {Math.abs(percent)}%
                              </span>
                            )}
                            <span
                              class={`${style.status} ${
                                item.status === 'done'
                                  ? style.statusDone
                                  : item.status === 'error'
                                  ? style.statusError
                                  : item.status === 'processing'
                                  ? style.statusProcessing
                                  : ''
                              }`}
                            >
                              {item.status === 'done'
                                ? '✓ Done'
                                : item.status === 'processing'
                                ? 'Converting'
                                : item.status === 'error'
                                ? 'Failed'
                                : 'Pending'}
                            </span>
                          </div>
                          {item.url && (
                            <a
                              class={style.iconButton}
                              href={item.url}
                              download={name}
                              title={`Download ${name}`}
                            >
                              <Icon name="download" />
                            </a>
                          )}
                          <button
                            class={style.iconButton}
                            disabled={running || zipping}
                            onClick={() => this.remove(item)}
                            title={`Remove ${item.file.name}`}
                          >
                            <Icon name="close" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div class={style.queueFooter}>
                  <span>
                    <i /> Private by design
                  </span>
                  <span>Powered by Squoosh’s original codecs</span>
                </div>
              </div>
              <p class={style.bottomNote}>
                More images, less waiting. Your browser does all the work.
              </p>
            </section>
          </div>
          <footer class={style.footer}>
            <span>
              squoosh <b>/</b> A little smaller. A lot better.
            </span>
            <button onClick={this.props.onClassic} disabled={running}>
              Explore the original editor ↗
            </button>
          </footer>
        </div>
      </main>
    );
  }
}
