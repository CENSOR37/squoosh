# [Squoosh]!

[Squoosh] is an image compression web app that reduces image sizes through numerous formats.

## Batch workspace

The home page now supports multiple images with a dark, responsive interface.
Drop images or choose multiple files, select an output format, then use **Compress all**.
All supported original encoders and their advanced controls are available, along with
resize, palette reduction and rotation. Processing is sequential to limit peak memory.

- Download individual results or a ZIP of completed images, including partially completed batches.
- Set a naming prefix, suffix and sequence numbers, or edit individual output stems. Duplicate output names are disambiguated automatically.
- Stop and resume unfinished work; failed images do not block the rest of the queue.
- Changing encoding or processing settings clears previous results so downloads match the current settings.
- Resize can fit each image inside the target dimensions while preserving its own aspect ratio. Turn this off to use the original exact-size and fit controls.
- Save and restore batch settings on the current device.
- Use **Edit** on a queued image or **Single image editor** to access the original two-sided comparison, zoom, background, smoothing, rotation and saved side settings. The original editor uses its own settings; returning keeps the batch queue and results.

Queues live in memory and are cleared on reload. ZIP downloads use the standard ZIP
format (up to 65,535 files and under 4 GB); larger results can be downloaded individually.

After `npm install` and `npm run build`, run `npm run preview` to open the app at
`http://localhost:5000` (works in PowerShell as well). Run `npm test` for batch queue,
cancellation, naming, resize and ZIP regression tests.

# Privacy

Squoosh does not send your image to a server. All image compression processes locally.

However, Squoosh utilizes Google Analytics to collect the following:

- [Basic visitor data](https://support.google.com/analytics/answer/6004245?ref_topic=2919631).
- The before and after image size value.
- If Squoosh PWA, the type of Squoosh installation.
- If Squoosh PWA, the installation time and date.

# Developing

To develop for Squoosh:

1. Clone the repository
1. To install node packages, run:
   ```sh
   npm install
   ```
1. Then build the app by running:
   ```sh
   npm run build
   ```
1. After building, start the development server by running:
   ```sh
   npm run dev
   ```

# Contributing

Squoosh is an open-source project that appreciates all community involvement. To contribute to the project, follow the [contribute guide](/CONTRIBUTING.md).

[squoosh]: https://squoosh.app
