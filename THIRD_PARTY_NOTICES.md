# Third-Party Notices

The Short Drama Director project includes or interoperates with third-party
software and specifications. This project's license does not override those
licenses or ownership claims.

## DeepSeek Harness

The plugin runs inside DeepSeek Harness / DSH Desktop and declares official
`@deepseek-ai/*` packages as peer dependencies. Those packages are not bundled
as runtime dependencies in this repository and remain subject to their own
licenses and terms.

## adm-zip

`vendor/adm-zip/` contains the vendored adm-zip runtime used to read `.docx`
prompt sources. Its MIT license is reproduced at
`vendor/adm-zip/LICENSE`.

## Qwen Image 2.1 prompt skill

`skills/qwen-image-2-1-prompter/` is based on:

- Qwen: https://github.com/QwenLM/Qwen-Image-2.1
- Prompt skill: https://github.com/iamyoki/qwen-image-2.1-skill

The source record is kept in `skills/qwen-image-2-1-prompter/SOURCE.md`.
The upstream material is identified there as Apache-2.0. Local integration and
normalization logic added for this plugin is covered by this project's license.

## H3 prompt specifications and reference material

The H3 prompt structure, labels, examples, and validation references in
`skills/h3-prompt-converter/` and `skills/h3-prompt-writing/` are derived from
MiniMax H3 documentation and the prompt-writing specification supplied for the
workflow. Rights in the upstream specification and examples remain with their
original authors. The project license applies only to original integration and
conversion code added here.

## ComfyUI, nodes, workflows, and models

The repository does not redistribute ComfyUI, custom nodes, model weights, or
the large integrated deployment package. The public Quark package contains
third-party components under their own licenses. Users are responsible for
reviewing and complying with those licenses before use, redistribution, or
commercial deployment.

## User projects and generated content

No user projects, reference images, generated videos, personal data, API keys,
or cloud credentials are part of this repository.
