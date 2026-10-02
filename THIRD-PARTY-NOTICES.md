# Third-party notices

Muesli includes or depends on the following components. Each remains under its own licence.

## Shipped inside the app

| Component | Use | Licence |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | App runtime | MIT |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and ggml | Speech-to-text engine | MIT |
| [Whisper models](https://github.com/openai/whisper) (large-v3-turbo, base.en, in ggml format) | Speech-to-text model weights | MIT |
| [Silero VAD](https://github.com/snakers4/silero-vad) (v5.1.2, in ggml format) | Skips silence before transcription | MIT |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Tells apart the speakers on the other side of a call | Apache-2.0 |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | Runs the speaker models | MIT |
| [pyannote segmentation 3.0](https://huggingface.co/pyannote/segmentation-3.0) (ONNX export) | Finds where each speaker starts and stops | MIT |
| [NVIDIA TitaNet Small](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_small) (ONNX export) | Voice fingerprints for telling speakers apart | CC BY 4.0 |
| [Instrument Sans](https://github.com/Instrument/instrument-sans) | Interface font | SIL Open Font License 1.1 |
| [Newsreader](https://github.com/productiontype/Newsreader) | Heading font | SIL Open Font License 1.1 |
| [IBM Plex Mono](https://github.com/IBM/plex) | Monospace font | SIL Open Font License 1.1 |

## Used but not shipped

| Component | Use | Licence |
| --- | --- | --- |
| [Ollama](https://github.com/ollama/ollama) | Runs the notes model; installed by the user | MIT |
| Qwen models | Write the notes; downloaded by the user through Ollama | See each model's page on ollama.com |

Full licence texts are available at the links above.
