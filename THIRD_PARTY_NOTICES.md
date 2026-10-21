# Third-party notices

This project includes, or downloads at runtime, the third-party material listed below.

## Application code

Portions of this software are derived from code licensed under the MIT License:

```
Copyright (c) 2026 Zephyr Huang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Speech models (downloaded on first use, not bundled)

### Phonon-2

Phonon-2 by Fermion Research, based on Parakeet TDT 0.6B v3 by NVIDIA.
Licensed under the Creative Commons Attribution 4.0 International License
(CC BY 4.0): https://creativecommons.org/licenses/by/4.0/

- Model: https://huggingface.co/FermionResearch/Phonon-2
- The `fermion-research` runtime is licensed under the Apache License 2.0.
- The runtime is installed with uv by Astral (MIT or Apache License 2.0,
  https://github.com/astral-sh/uv), which downloads CPython (Python Software
  Foundation License) and the Python packages `fermion-research` depends on,
  each under its own license.

### Qwen3-ASR 0.6B

Qwen3-ASR by the Qwen team at Alibaba Cloud, licensed under the Apache License 2.0:
https://www.apache.org/licenses/LICENSE-2.0

Quantized builds are converted by third parties and keep the same license.
