import type { FileDropEvent } from 'file-drop-element';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import type { SnackOptions } from 'shared/custom-els/snack-bar';

import { h, Component } from 'preact';

import { linkRef } from 'shared/prerendered-app/util';
import * as style from './style.css';
import 'add-css:./style.css';
import 'file-drop-element';
import 'shared/custom-els/snack-bar';
import Intro from 'shared/prerendered-app/Intro';
import 'shared/custom-els/loading-spinner';

const ROUTE_EDITOR = '/editor';

const compressPromise = import('client/lazy-app/Compress');
const batchPromise = import('client/lazy-app/Batch');
const swBridgePromise = import('client/lazy-app/sw-bridge');

interface Props {}

interface State {
  awaitingShareTarget: boolean;
  file?: File;
  isEditorOpen: Boolean;
  Compress?: typeof import('client/lazy-app/Compress').default;
  Batch?: typeof import('client/lazy-app/Batch').default;
  incoming: File[];
  classic: boolean;
}

export default class App extends Component<Props, State> {
  state: State = {
    awaitingShareTarget: new URL(location.href).searchParams.has(
      'share-target',
    ),
    isEditorOpen: false,
    file: undefined,
    Compress: undefined,
    incoming: [],
    classic: location.pathname === '/classic',
  };

  snackbar?: SnackBarElement;

  constructor() {
    super();

    batchPromise
      .then((module) => this.setState({ Batch: module.default }))
      .catch(() =>
        this.showSnack('Failed to load batch workspace. Please reload.'),
      );

    compressPromise
      .then((module) => {
        this.setState({ Compress: module.default });
      })
      .catch(() => {
        this.showSnack('Failed to load app');
      });

    swBridgePromise.then(async ({ offliner, getSharedImage }) => {
      offliner(this.showSnack);
      if (!this.state.awaitingShareTarget) return;
      const file = await getSharedImage();
      // Remove the ?share-target from the URL
      history.replaceState('', '', '/');
      this.openEditor();
      this.setState({ file, awaitingShareTarget: false });
    });

    // Since iOS 10, Apple tries to prevent disabling pinch-zoom. This is great in theory, but
    // really breaks things on Squoosh, as you can easily end up zooming the UI when you mean to
    // zoom the image. Once you've done this, it's really difficult to undo. Anyway, this seems to
    // prevent it.
    document.body.addEventListener('gesturestart', (event: any) => {
      event.preventDefault();
    });

    window.addEventListener('popstate', this.onPopState);
  }

  private onFileDrop = ({ files }: FileDropEvent) => {
    if (!files || files.length === 0) return;
    if (files.length === 1 && (this.state.isEditorOpen || this.state.classic)) {
      this.onIntroPickFile(files[0]);
    } else {
      this.openBatch();
      this.setState({ incoming: Array.from(files) });
    }
  };

  private onIntroPickFile = (file: File) => {
    this.openEditor();
    this.setState({ file });
  };

  private showSnack = (
    message: string,
    options: SnackOptions = {},
  ): Promise<string> => {
    if (!this.snackbar) throw Error('Snackbar missing');
    return this.snackbar.showSnackbar(message, options);
  };

  private onPopState = () => {
    this.setState({
      isEditorOpen: location.pathname === ROUTE_EDITOR && !!this.state.file,
      classic: location.pathname === '/classic',
    });
  };

  private openBatch = () => {
    if (location.pathname !== '/') history.pushState(null, '', '/');
    this.setState({ isEditorOpen: false, classic: false });
  };

  private openClassic = () => {
    history.pushState(null, '', '/classic');
    this.setState({ isEditorOpen: false, classic: true });
  };

  private openEditor = () => {
    if (this.state.isEditorOpen) return;
    // Change path, but preserve query string.
    const editorURL = new URL(location.href);
    editorURL.pathname = ROUTE_EDITOR;
    history.pushState(null, '', editorURL.href);
    this.setState({ isEditorOpen: true });
  };

  render(
    {}: Props,
    {
      file,
      isEditorOpen,
      Compress,
      Batch,
      incoming,
      classic,
      awaitingShareTarget,
    }: State,
  ) {
    const showSpinner =
      awaitingShareTarget || (isEditorOpen ? !Compress : !classic && !Batch);

    return (
      <div class={style.app}>
        <file-drop
          multiple
          onfiledrop={this.onFileDrop}
          class={`${style.drop} ${isEditorOpen ? '' : style.scrollable}`}
        >
          {Batch && (
            <div
              class={style.batchHost}
              hidden={!!isEditorOpen || classic || awaitingShareTarget}
            >
              <Batch
                incoming={incoming}
                onInspect={this.onIntroPickFile}
                onClassic={this.openClassic}
                showSnack={this.showSnack}
              />
            </div>
          )}
          {showSpinner ? (
            <loading-spinner class={style.appLoader} />
          ) : isEditorOpen ? (
            Compress && (
              <Compress
                file={file!}
                showSnack={this.showSnack}
                onBack={this.openBatch}
              />
            )
          ) : classic ? (
            <div class={style.classicHost}>
              <button class={style.returnToBatch} onClick={this.openBatch}>
                ← Batch workspace
              </button>
              <Intro onFile={this.onIntroPickFile} showSnack={this.showSnack} />
            </div>
          ) : null}
          <snack-bar ref={linkRef(this, 'snackbar')} />
        </file-drop>
      </div>
    );
  }
}
