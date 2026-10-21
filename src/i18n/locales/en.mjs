// English: the default language, and the fallback when another language lacks a sentence. Other languages follow this file's structure, names and parameters matching one to one.
// {name} is a parameter; { one, other } splits by plural on count (Intl.PluralRules categories).
// A sentence shown to people has no ending punctuation (it often runs on after other text); only full explanations do.

export default {
  common: {
    sentence: "{text}.",
    unknownReason: "unknown reason",
    close: "Close",
  },

  units: {
    seconds: "{value}s",
    minutesSeconds: "{minutes}m {seconds}s",
    minutes: "{minutes} min",
    hoursMinutes: "{hours} hr {minutes} min",
    min: "min",
    hr: "hr",
    words: { one: "word", other: "words" },
    wpm: "WPM",
    days: { one: "day", other: "days" },
  },

  periods: {
    today: "Today",
    month: "This month",
    total: "All time",
  },

  months: {
    jan: "Jan",
    feb: "Feb",
    mar: "Mar",
    apr: "Apr",
    may: "May",
    jun: "Jun",
    jul: "Jul",
    aug: "Aug",
    sep: "Sep",
    oct: "Oct",
    nov: "Nov",
    dec: "Dec",
  },

  permissions: {
    microphone: "Microphone",
    listen: "Input Monitoring",
    trusted: "Accessibility",
    granted: "Granted",
    denied: "Not granted",
    checking: "Checking…",
    openSettings: "System Settings",
    request: "Allow",
  },

  hotkeys: {
    right_option: { name: "Right Option", keycap: "Right ⌥" },
    right_command: { name: "Right Command", keycap: "Right ⌘" },
    right_control: { name: "Right Control", keycap: "Right ⌃" },
    fn: { name: "Globe (fn)", keycap: "fn" },
    right_alt: { name: "Right Alt", keycap: "Right Alt" },
    right_ctrl: { name: "Right Ctrl", keycap: "Right Ctrl" },
  },

  themes: {
    ink: { name: "Ink", describe: "Black and white. Shape and motion show the state; color only for errors" },
    cinnabar: { name: "Cinnabar", describe: "A warm red on the wave and the main buttons" },
    indigo: { name: "Indigo", describe: "Color shows the stage: green listening, indigo refining, amber trouble" },
  },

  providers: {
    gemini: { name: "Google Gemini", getKey: "Get one at Google AI Studio" },
    openai: { name: "OpenAI", getKey: "Get one at OpenAI Platform" },
    ollama: { name: "Ollama" },
    custom: { name: "Custom service" },
  },

  language: {
    system: "System",
  },

  settings: {
    describe: {
      hotkey: "Which key starts and stops dictation",
      mode: "Which way to recognize speech: native sends the recording to a model that takes audio; local transcribes on this Mac first, then has any LLM polish the text; private only transcribes on this Mac and uploads nothing",
      model:
        "Which provider and model refines your words, as provider/model; a provider alone uses its default. Switch with whisprflow model",
      thinking: "Gemini's thinking level; higher is slower. Other providers don't use it",
      transcriber:
        "On the local path, which on-device model transcribes; download it first (whisprflow transcriber download)",
      privateTranscriber:
        "On the private path, which on-device model transcribes; on-device models only, download it first",
      polish:
        "On the local path, which provider and model polishes the text, as provider/model; for a custom service write custom/<model>",
      customUrl: "Address of your custom polishing service (OpenAI-compatible), e.g. https://api.example.com/v1",
      modelSource:
        "Where on-device models download from: original is Hugging Face, mirror is hf-mirror.com. If the chosen one stalls, the other is tried",
      acceleration:
        "Whether on-device models use the GPU: auto uses it when there is one and falls back to the CPU if it fails; cpu uses only the CPU (for GPU driver trouble, or to leave the GPU to other programs)",
      barHint: "Whether the hint line above the voice bar (press … to finish · esc to cancel) shows: on or off",
      theme: "Which theme the windows use",
      language: "Interface language; system follows your Mac",
    },
    unknown: "There's no setting called {name}. You can change: {names}",
    notText: "must be text",
    oneOf: "must be one of {choices}",
    invalid: "{where} is {value}: {reason}",
    whereEnv: "The {variable} env var",
    whereFile: "{name} in the settings file {file}",
    unreadable: "Can't read the settings file {file} ({reason}). Fix it, or delete it and set things again.",
    notObject:
      'The settings file {file} isn\'t a set of "name": value pairs. Fix it, or delete it and set things again.',
  },

  models: {
    empty: "is empty",
    unknownProvider: "unknown provider {name}; available: {providers}",
    badName: "model name {model} is invalid: only letters, digits, and . _ : - are allowed",
    issues: { jsonWrapped: "Occasionally wraps the text in JSON or returns HTTP 500" },
  },
  modes: {
    native: "Native: the recording goes straight to the model",
    local: "Local: transcribed on this Mac, then polished by a model",
    private: "Private: transcribed on this Mac only, nothing uploaded",
    privateOnlyLocal: "Private mode only uses on-device models; {model} is a cloud model",
    notIn: "You're in {current} mode; {what} can only be changed in {mode} mode",
    notOfMode: "{name} isn't a {mode} setting; switching to {mode} can also set {names}",
    notDownloaded: "{model} isn't downloaded yet ({size}): download it first",
    what: {
      model: "the audio model",
      transcriber: "the on-device transcription model (step 1)",
      polish: "the polishing model (step 2)",
      privateTranscriber: "the private mode's on-device model",
    },
  },
  local: {
    modelDownloading: "The local model is still downloading ({percent}%); it'll work once it's done",
    modelLoading: "The local model is loading; give it a few seconds",
    modelFailed: "The local model couldn't be set up: {reason}",
    modelMissing:
      "The local model {model} isn't downloaded: download it on the Models page in Settings, or run whisprflow transcriber download {id}",
    undecodable: "Couldn't read the recording: {reason}",
    cleanupSkipped: "Cleanup skipped, pasted what was heard: {reason}",
    transcribeFailed: "Local transcription failed: {reason}",
  },
  modelSources: {
    original: "Hugging Face",
    mirror: "Hugging Face mirror (hf-mirror.com)",
  },
  accelerations: {
    auto: "Automatic (GPU if available)",
    cpu: "CPU only",
  },
  barHints: {
    on: "Shown",
    off: "Hidden",
  },
  localModels: {
    tags: {
      "apple-silicon": "suits Apple silicon",
      "windows-x64": "suits Windows",
      metal: "Metal-accelerated",
      vulkan: "GPU-accelerated (Vulkan)",
      cpu: "runs on CPU alone",
      "zh-en": "strong on mixed Chinese and English",
    },
    chips: {
      "apple-silicon": "Apple silicon",
      "intel-mac": "Intel Macs",
      "windows-x64": "Windows (x64)",
      "windows-arm64": "Windows (ARM)",
    },
    backends: { metal: "Metal", vulkan: "Vulkan", cpu: "CPU" },
    measured: "Measured on {chip} ({backend}): {score}/5 · {realtime}× real time · {memory} memory",
    figures: { score: "score", speed: "speed", memory: "memory" },
    measuredOn: "Measured on {chip} · {backend}",
    notMeasured: "Not yet measured on {chip}",
    unknownChip: "Not yet measured on this kind of machine",
    unknown: "There's no model called {id}",
    noSpace: "Not enough disk space: {model} needs {need} more, and only {free} is free",
    downloadFailed: "{model} didn't download: {reason}",
    inUse: "{model} is in use and can't be deleted: switch to another model or back to native first",
    checkNoSpeech: "Couldn't speak the test sentence (uses the system voice): {reason}",
    checkFailed: "{model} failed to transcribe: {reason}",
    checkEmpty: "{model} didn't transcribe a single word",
  },
  chat: {
    modelRequired: "{vendor} has no default model; write it as {vendor}/<model name>",
    badModelName: "model name {model} is invalid: only letters, digits, and . _ : / @ + - are allowed",
    urlEmpty: "the address is empty",
    urlNotHttp: "{url} isn't a web address; it should start with https:// or http://",
    urlCredentials: "don't put a username or password in the address; the key goes in separately",
    urlQuery: "the address can't contain ? or #",
    urlMissing: "no address set for the custom service (customUrl)",
    endpointNotFound:
      "{provider} has no chat API at this address (HTTP 404). Check the address is complete; most end in /v1",
  },

  setup: {
    openSettings: "menu bar icon › Settings",
    missing: {
      key: "{provider} API key",
      check: "{provider} check",
      microphone: "microphone access",
      listen: "Input Monitoring access",
      helper: "key listener",
      localModel: "local model",
      localModelDownloading: "local model (downloading, {percent}%)",
    },
    blocker: {
      noKey: "No {provider} API key: {where}",
      checkFailed: "{provider} check failed: {problem}",
      keyRejected: "API key not working: {problem}",
      checking: "Checking the API key, one moment",
      noMicrophone: "No microphone access: {where}",
    },
    degraded: "No Accessibility access: text goes to the clipboard, press ⌘V",
    cleanupOff: "Cleanup is off for now, so dictation pastes what was heard: {problem}",
  },

  key: {
    empty: "No key entered",
    routeChanged: "The recognition mode just changed, so this key wasn't saved. Save it again",
    tooLong: "This key is too long ({length} characters). Looks like a copy mistake",
    whitespace: "This key has spaces or line breaks. Looks like extra text got copied",
    badCharacters: "This key has characters that don't belong. Looks like a copy mistake",
    unreadable: "The saved key can't be read anymore. Enter it again",
    unreadableFor: "The saved {provider} key can't be read anymore. Enter it again",
    notSaved: "The key works but wasn't saved ({reason}). You'll need to enter it again after quitting",
    keychainUnavailable: "The system keychain isn't available, so the key can't be stored safely",
    external: "Connected to a separately started server (WHISPRFLOW_SERVER_URL); set the key there",
    externalModel: "Connected to a separately started server (WHISPRFLOW_SERVER_URL); the model is chosen there",
    noKeyFor: "No {provider} key",
    noKeyForCli: "No {provider} key yet: run whisprflow key {id}",
    unknownProvider: "Unknown model provider: {id}",
    noKeyService:
      "No {provider} API key yet: run whisprflow key in a terminal, or open Settings from the WhisprFlow menu bar icon",
    noKeyServiceFor:
      "No {provider} API key yet: run whisprflow key {id} in a terminal, or open Settings from the WhisprFlow menu bar icon",
    failedFor: "{provider} key failed: {reason}",
    whichVendor: "Private mode doesn't use a key; to save one, say which provider it's for",
  },

  model: {
    timeout: "{provider} took too long to reply. Try again later",
    unreachable: "Can't reach {provider}. Check your network",
    localNotRunning: "{provider} isn't running. Start it, or install it from ollama.com",
    notPulled: "{model} isn't downloaded in {provider} yet",
    keyInvalid: "This key is invalid. Check it was copied in full",
    unavailable: "{provider} is unavailable right now ({said}). Try again later",
    rejected: "{provider} rejected the request: {said}",
    regionBlocked:
      "{provider} isn't available in your network's region ({said}). Check your proxy or switch networks; the key is fine",
    noQuota: "This key's account is out of credit. Top up or use another key",
    forbidden: "This key lacks permission: {said}",
    notFound: "{provider} doesn't have this model, or this key can't use it: {said}",
    blocked: "{provider} didn't process this dictation: {reason}",
    notActivated: "This model isn't activated on {provider}. Activate it in the console, then try again",
    unfinished: "{provider} didn't finish normally: {reason}",
  },

  audio: {
    undecodable: "Couldn't decode the recording ({type}): {reason}",
    empty: "Couldn't decode the recording ({type}): it has no audio",
  },

  voice: {
    noAudio: "No audio received",
    connectTimeout: "Timed out connecting to the server",
    unreachable: "Can't reach the server at {url}",
    disconnected: "Lost the connection to the server",
    timeout: "No result after {seconds} seconds",
    serverError: "Server error {code}: {detail}",
  },

  delivery: {
    silent: "Didn't hear anything",
    noAccessibility: "No Accessibility access: text copied, press ⌘V to paste",
    pasteFailed: "Couldn't paste: text copied, press ⌘V to paste",
    // Windows only: the system blocks simulated keystrokes into windows running as administrator
    elevated: "That window runs as administrator, so text can't be pasted into it: text copied, press Ctrl+V to paste",
  },

  bar: {
    opening: "Opening microphone…",
    recording: "Press {key} to finish · {esc} to cancel",
    recordingNoEsc: "Press {key} to finish",
    finishing: "Refining",
    noHold: "No need to hold: press once to start, again to finish",
    noMicPermission: "No microphone access: System Settings › Privacy & Security › Microphone",
    noMicrophone: "No microphone found",
    noSignal: "The microphone isn't picking anything up: check the input device and mute",
    recordError: "Recording error: {reason}",
    helperStopped: "Key listener stopped; {hotkey} won't work. Try restarting WhisprFlow",
  },

  tray: {
    ready: "Ready · press {keycap} to talk",
    missing: "Missing: {items}",
    preparing: "Getting ready…",
    open: "Open WhisprFlow",
    history: "History",
    settings: "Settings…",
    version: "Version {version}",
    quit: "Quit WhisprFlow",
    fallbackTitle: "Dictate",
  },

  notes: {
    settingNotSaved: "Switched, but couldn't save {name} to settings ({reason}) · next launch goes back",
    envNextLaunch: "The {variable} env var takes priority · next launch still uses it",
    envRemove: "The {variable} env var takes priority · remove it to apply",
  },

  hub: {
    pages: "Pages",
    home: "Home",
    models: "Models",
    history: "History",
    settings: "Settings",
    about: "About",
    missing: "Missing: {items}",
    fix: "Settings",
    switchWay: "Switch mode",
  },

  plaza: {
    title: "Models",
    search: "Search models or makers",
    modes: { native: "Native", local: "Transcribe + Polish", private: "Data Privacy" },
    facts: { upload: "Audio sent to {platform}" },
    // This role isn't part of the recognition mode in use (the line under the models toolbar)
    standby: {
      elsewhere: "Mode in use: {current} · Enabling a model here switches to {mode}",
      privateCloud: "Data Privacy uses on-device models only · Enabling a cloud model switches to {mode}",
      pick: "Change mode",
    },
    via: { local: "This Mac" },
    inUse: "In use",
    chosen: "Selected",
    chosenTip: "Used in {mode}",
    actionFailed: "Not completed",
    check: {
      run: "Check",
      running: "Checking",
      ok: "Passed",
      fail: "Failed",
      again: "Check again",
      okAgain: "Passed, check again",
      failAgain: "Failed, check again",
      modelTip: "Send a sample request",
      localTip: "Transcribe a spoken sample",
      keyTip: "Send a minimal request with this key",
    },
    tabs: { label: "Model categories", native: "Native", transcribe: "Transcribe", polish: "Polish", keys: "Keys" },
    toolbar: {
      all: "All",
      makers: "Filter by maker",
      best: "Best in column",
      keysLocal: "Keys stay on this Mac",
      onlyUsable: "Available only",
      perMillion: "Price · per million tokens",
    },
    cols: {
      model: "Model",
      platform: "Platform",
      status: "Status",
      action: "Action",
      key: "Key",
      input: "Input",
      inputTip: "Input price · per million tokens",
      output: "Output",
      outputTip: "Output price · per million tokens",
      hour: "Per hour",
      hourTip: "Cost to transcribe one hour of audio",
      hourApprox: "Cost to transcribe one hour of audio · Billed by token, estimated from a measured run",
      noPrice: "See the platform's pricing",
      free: "Free",
      zh: "Chinese",
      zhTip: "Chinese accuracy · 47 real recordings, out of 5",
      mix: "Mixed",
      mixTip: "Chinese-English accuracy · 45 real recordings, out of 5",
      minute: "1-min time",
      minuteTip: "Time to transcribe one minute of audio · From the measured real-time factor",
      memory: "Memory",
      memoryTip: "Peak memory while transcribing",
      size: "Size",
      sizeTip: "Download size",
    },
    units: { seconds: "s" },
    tags: {
      default: "Default",
      defaultTip: "Enabled after install",
      tested: "Evaluated",
      testedTip: "Evaluated on a batch of real recordings",
      issue: "Known issue",
      unverified: "Unverified",
      unverifiedTip: "Added from the official docs; not yet called",
    },
    build: "{backend}",
    buildTip: "Quantization {variant}",
    makers: {
      qwen: "Qwen",
      gemini: "Gemini",
      openai: "OpenAI",
    },
    groups: {
      local: "On this Mac",
      custom: "Custom",
      localMeta: "Audio stays on this Mac · {done}/{total} downloaded",
      localMetaFree: "Audio stays on this Mac · {done}/{total} downloaded · {free} free",
    },
    channel: {
      label: "Channel",
      official: "Official",
      officialOf: "{platform} official",
      keyed: "Key configured",
      noKey: "No key",
    },
    notice: { noKey: "No key configured", custom: "Not configured" },
    actions: {
      use: "Enable",
      download: "Download",
      cancel: "Cancel",
      configure: "Configure",
      configureKey: "Add key",
      needKey: "Add a key first",
      remove: "Remove",
      removeModel: "Remove {model}",
    },
    custom: {
      name: "Custom service",
      desc: "OpenAI-compatible API · Your own address, model, and key",
      meta: "OpenRouter, LM Studio, vLLM, and others",
      url: "API address",
      urlPlaceholder: "API address, e.g. https://api.example.com/v1",
      model: "Model name",
      modelPlaceholder: "Model name",
    },
    empty: { title: "No matching models", search: "Search for {query}", clear: "Clear filters" },
    keys: {
      coverage: "Covers",
      env: "Environment",
      envTip: "From the environment variable {variable}; takes precedence over a saved key",
      stored: "Configured",
      none: "Not configured",
      placeholder: "Paste your {platform} API key",
      label: "{platform} API key",
      save: "Save",
      cancel: "Cancel",
      remove: "Remove",
      collapse: "Collapse",
      replace: "Replace",
      get: "Get a key",
    },
    toast: {
      switchedWith: "Switched to {mode} · {model}",
      enabled: "{model} enabled",
      keySaved: { one: "Key saved · {count} model now available", other: "Key saved · {count} models now available" },
      keySavedOnly: "Key saved",
      keyRemoved: "{platform} key removed",
      canceled: "Download canceled",
      removed: "{model} removed",
    },
    notes: {
      keys: "Stored in {home}",
      transcribe: "On-device scores · 97 real recordings, Apple silicon, 2026-10-16 · Hover a column for details",
      prices: "Tags · Default, Evaluated, Known issue, Unverified · Prices in USD as listed by each platform",
    },
  },

  // Recommended setups next to the models page title (src/models/presets.mjs, renderer/hub/preset-picker.mjs). Monthly cost at 100 a day, 30 days
  presets: {
    title: "Recommended setups",
    meta: "Monthly cost at {daily} dictations a day",
    perMonth: "/ mo",
    costTip: "{daily} a day · about {seconds} s each · weekday peak prices",
    costUnknown: "Price unknown",
    enable: "Enable",
    enabling: "Enabling",
    checkTip:
      "Checks the whole setup: the on-device model transcribes a sample, each cloud service gets a minimal request",
    enabled: "Enabled {name}",
    download: "Download {size}",
    downloading: "Downloading {model}",
    items: {
      "local-qwen": { name: "On-device + Ollama", desc: "AI cleanup · Nothing uploaded · Free" },
      "native-gemini": { name: "Gemini Native", desc: "One step · One key" },
      "native-openai": { name: "OpenAI Native", desc: "One step · One key" },
      "private-qwen": { name: "Fully On-device", desc: "Nothing uploaded · Free" },
      "local-qwen-cpu": { name: "On-device + Ollama", desc: "AI cleanup · Nothing uploaded · Free" },
      "private-qwen-cpu": { name: "Fully On-device", desc: "Nothing uploaded · Free" },
    },
  },

  home: {
    title: "Speak, don't type",
    words: "Words",
    saved: "Time saved",
    speed: "Speed",
    time: "Dictation time",
    active: "Active",
    streak: "Streak",
    longest: "Longest",
    activity: "Dictations per day",
    earlier: "Earlier",
    later: "Later",
    less: "Less",
    more: "More",
    notStarted: "{day} · not started yet",
    dayCount: { one: "{day} · {count} dictation · {level}", other: "{day} · {count} dictations · {level}" },
    dayLevel: "{day} · {level}",
    levels: {
      none: "No activity",
      light: "Light usage",
      moderate: "Moderate usage",
      high: "High usage",
      power: "Power usage",
    },
    spend: { today: "Spent today", month: "Spent this month", total: "Spent in all" },
    spendPeriods: "Period",
    model: "Model",
    cost: "Cost",
    tokens: "Tokens",
    count: "Count",
    latency: "Latency",
    local: "On-device",
    free: "Free",
    sum: "Total",
    emptyPeriod: "Nothing used in this period",
    checks: { one: "Includes {count} check", other: "Includes {count} checks" },
    cache: "Prompt cache {cost}",
    estimate: "Estimated at list prices",
    unpriced: "{models} unpriced; {count} not counted",
    dictate: "Press to talk",
    // The recognition mode menu next to the title (renderer/hub/mode-picker.mjs); mode names live in plaza.modes
    mode: {
      label: "Recognition",
      meta: "Choose one of three · Each keeps its own models",
      desc: {
        native: "Audio straight to the model · One request",
        local: "Speech transcription · Text polishing",
        private: "On-device transcription · Nothing uploaded",
      },
      needs: {
        key: "No {platform} key",
        download: "{model} not downloaded",
        downloading: "Downloading {model} · {percent}%",
        url: "No custom service URL",
      },
      fix: "Set up",
      switching: "Switching",
      failed: "Not switched",
      switched: "Switched to {mode}",
      configure: "Change the models {mode} uses",
      locked: "The mode is set by the separately started server and can't be changed here",
    },
  },

  history: {
    title: "History",
    empty: "Nothing yet · press {keycap} to say something",
    loadError: "Couldn't read history: {reason}",
    today: "Today",
    yesterday: "Yesterday",
    silent: "Audio is silent",
    failed: "Failed · ",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
    recording: "Recording {duration}",
    model: "Model {latency} · {cost}",
    tokens: "In {input} · out {output} tokens",
    tokensCalls: "In {input} · out {output} tokens · {calls} calls",
    unpriced: "price unknown",
  },

  preferences: {
    title: "Settings",
    sections: "Settings sections",
    general: "General",
    permissions: "Permissions",
    dictionary: "Dictionary",
    about: "About",
    hotkey: "Shortcut",
    theme: "Theme",
    language: "Language",
    modelSource: "Model download source",
    acceleration: "On-device model acceleration",
    barHint: "Hints above the voice bar",
    openAtLogin: "Launch at login",
    hotkeyFailed: "Not changed: {reason}",
    themeFailed: "Theme not changed: {reason}",
    languageFailed: "Language not changed: {reason}",
    loginFailed: "Couldn't set launch at login: {reason}",
    sourceFailed: "Download source not changed: {reason}",
    accelerationFailed: "Acceleration not changed: {reason}",
    barHintFailed: "Hint setting not changed: {reason}",
    recheck: "Check again",
    version: "Version",
    dataFolder: "Data folder",
    source: "Source code",
  },

  ollama: {
    pullFailed: "Couldn't pull {model} into Ollama: {reason}",
    notInUse: "Local cleanup isn't set to Ollama",
  },

  dictionary: {
    explain:
      "Names and jargon spelled the way you want, one per line. Cleanup prefers these spellings, and on-device cleanup adds new ones it hears.",
    save: "Save",
    count: { one: "{count} term", other: "{count} terms" },
    learningPaused: "{count} terms: learning has paused at {max}. Remove some to let it learn again",
    saved: "Saved",
    saveFailed: "Not saved: {reason}",
  },

  keyPanel: {
    paste: "Paste",
    verifying: "Verifying",
    failed: "Failed: {reason}",
    clipboardEmpty: "Clipboard is empty",
    confirmForget: "Delete the {provider} key?",
    confirmForgetInUse: "Delete the {provider} key? You'll need to add it again to dictate",
    other: {
      env: "Env var {variable}",
    },
    check: {
      button: "Check",
      running: "Checking",
      ok: "Check passed",
      failed: "Check failed: {problem}",
    },
    state: {
      env: "Env var {variable} · not saved",
      envUnverified: "Env var {variable} · not saved · not verified (couldn't reach {provider} at launch)",
      external: "Set by the separately started server",
      saved: "Saved · verified",
      savedUnverified: "Saved · not verified (couldn't reach {provider} at launch)",
      checking: "Verifying",
      checkFailed: "Check failed: {problem} · the key may be fine; see whisprflow model",
      envRejected: "The key in the {variable} env var failed the check: {problem} · fix or remove it, then restart",
      rejected: "The key failed the check: {problem}",
    },
  },

  onboarding: {
    groups: { model: "Model", setup: "Set up", try: "Try it" },
    way: {
      soft: "Pick a ",
      title: "recognition mode",
      key: "API key",
      local: "On-device model · {size}",
      offline: "No key",
      note: "Change it anytime in the main window · or skip and set it up later",
    },
    prepare: {
      native: { soft: "Connect a ", title: "native model" },
      local: { soft: "Transcribe on device, ", title: "polish in the cloud" },
      localOnly: { soft: "Transcribe and polish, ", title: "all on this computer" },
      private: { soft: "Download an ", title: "on-device model" },
      route: { label: "Route", audio: "Audio", text: "Text", local: "On-device" },
      sections: { model: "On-device model", native: "Native recognition", local: "Polish" },
      // Cleanup by Ollama on this computer (the Ollama section): no key, but it must run with the model pulled
      ollama: {
        ready: "Ready",
        local: "Runs on this computer",
        checking: "Checking Ollama",
        get: "Get Ollama",
        notRunning: "Ollama isn't running. Install it, or start it if it's installed, then check again",
        pull: "Pull",
      },
      model: {
        download: "Download",
        retry: "Retry",
        ready: "Downloaded",
        background: "Downloads in the background · you can continue",
        sources: { original: "Hugging Face", mirror: "Hugging Face mirror" },
      },
      nativeOnly: "Only these take audio directly · DeepSeek, Kimi, GLM and more are under Transcribe + Polish",
      later: "Optional · set it up later on the Models page",
      laterModel: "Optional · download it later on the Models page",
      more: "Cloud transcription and custom services are on the Models page",
      status: {
        enabled: "{mode} enabled",
        enabling: "Enabling",
        switched: "Switched to {mode} · ready once the items below are done",
        failed: "Not enabled",
        retry: "Retry",
      },
    },
    permissions: {
      soft: "Turn on three ",
      title: "permissions",
      allow: "Allow",
      on: "On",
      history: "History stays on this Mac",
      audio: "Audio goes only to your model",
      key: "Key encrypted on this Mac",
    },
    microphone: {
      soft: "Speak to ",
      title: "test the mic",
      question: "Are the bars moving?",
      yes: "Yes, continue",
      no: "No",
      help: "Check the input device and volume in System Settings › Sound, or turn on",
      settings: "Microphone access",
      error: "Can't open the microphone: {reason}",
    },
    hotkey: {
      soft: "Press it to ",
      title: "test the shortcut",
      question: "Did the key light up?",
      yes: "Yes, continue",
      no: "No, pick another key",
      switchTo: "Switch to",
      switched: "Switched. Press it to try",
      failed: "Not switched: {reason}",
    },
    try: {
      soft: "Now, ",
      title: "say something",
      sample: "Um, let's meet tomorrow at nine, no wait, nine thirty, and bring last week's numbers.",
      notes: "Notes",
      placeholder: "Click here, press {keycap}, read the line on the left, then press it again",
      downloading: "Downloading {model} · {percent}%",
      needDownload: "{model} not downloaded ({size})",
      needKey: "{vendor} API key missing",
      ollamaStopped: "Ollama isn't running",
      ollamaMissing: "{model} not pulled in Ollama",
      ollamaPulling: "Pulling {model} · {percent}%",
      preparing: "Preparing · ready shortly",
      fix: "Set up",
    },
    done: { soft: "Speak, ", title: "don't type", start: "Get started", mode: "Recognition", hotkey: "Shortcut" },
    back: "Back",
    next: "Continue",
    skipAll: "Skip setup",
  },

  paths: {
    homeNotAbsolute: "The WHISPRFLOW_HOME env var must be an absolute path; it's {home}",
    homeTooLong:
      "The WhisprFlow folder path is too long for the control socket: {home}\nUse the WHISPRFLOW_HOME env var to pick a shorter one.",
  },

  control: {
    notRunning: "WhisprFlow isn't running",
    timeout: "WhisprFlow didn't reply within {seconds} seconds (command {command})",
    unreadable: "Couldn't understand WhisprFlow's reply (command {command})",
  },

  storage: {
    historyTooNew:
      "The history database is version {found}, newer than this program knows ({known}), so it won't touch it",
    historyTooOld:
      "The history database is version {found}, but this program expects {known}: start WhisprFlow once, or update to the latest version",
  },

  cli: {
    help: `WhisprFlow: press a hotkey, speak, and polished text is pasted into the current text box.

  whisprflow                     Start (just shows status if already running). First run asks for an API key (Gemini by default)
  whisprflow start               Same as above
  whisprflow stop                Stop
  whisprflow restart             Restart
  whisprflow status [--json]     Status: running or not, key, system permissions, how much you said today and in total
  whisprflow update              Update to the latest version (on a Mac, WhisprFlow.app too if you have it). Settings, keys, history, and recordings are kept

  whisprflow history [-n count] [--json]
                                What you said, grouped by day, newest first (latest {limit} by default)
  whisprflow usage [--json]      What it cost: spend and tokens today, this month, and in total, model reply times, per model
  whisprflow mode                The three recognition modes and what each uses: native sends the recording to the model; local transcribes, then a model polishes it; private transcribes with an on-device model and uploads nothing
  whisprflow mode <native|local|private> [--model …] [--transcriber …] [--polish … --url …]
                                Switch mode, live. Can bring that mode's own settings, e.g. a custom service on first entering local
  whisprflow model               Native mode: available providers ({providers}), whether each has a key, which one is in use
  whisprflow model <provider>[/<model>]
                                Switch provider or model in native mode, e.g. whisprflow model openai. Asks for its key if missing
  whisprflow transcriber [<model>]
                                Local mode, step 1: list or switch the on-device transcription model. Asks before downloading one you don't have
  whisprflow transcriber download|cancel|delete <model> [--yes]
                                Download, stop downloading, or delete an on-device model (in any mode; the one in use can't be deleted)
  whisprflow transcriber check [<model>]
                                Check an on-device model: the system voice reads a sentence and the model transcribes it. Defaults to the selected one
  whisprflow polish [<provider>[/<model>] [--url <url>]]
                                Local mode, step 2: list or switch the polishing model ({polishers}). custom is any OpenAI-compatible service
  whisprflow polish check [<provider>[/<model>]]
                                Check step 2 works
  whisprflow model check [<provider>[/<model>]]
                                Check it works: sends that provider a minimal request with its key. Defaults to the current one
  whisprflow key [<provider>]    Replace a key; defaults to the current provider (input is hidden; can also be piped in)
  whisprflow key --forget [<provider>]
                                Delete the saved key
  whisprflow config              Settings: hotkey, model, thinking level, theme, language, and where data and logs live
  whisprflow config set <name> <value>
                                Change one directly, with no checks (the mode and model commands above check first)
  whisprflow config unset <name> Reset to the default
  whisprflow theme               List themes and the one in use
  whisprflow theme <name>        Switch theme ({themes}); applies right away, no restart
  whisprflow settings            Open Settings (to grant macOS permissions)
  whisprflow logs [-n lines] [-f]
                                Show logs; -f keeps following
  whisprflow uninstall [--keep-data] [--yes]
                                Uninstall: stop it and delete the whole WhisprFlow folder. --keep-data keeps settings, keys, history, and recordings

  whisprflow help                This help
  whisprflow --version           Version
`,
    macOnly:
      "WhisprFlow only supports macOS and Windows for now: listening for the hotkey and pasting rely on each system's own APIs.",
    nodeVersion: "WhisprFlow needs Node 22.13 or newer (23.4 or newer on the 23 line); this is {version}.",
    unknownCommand: "There's no command called {name}.",
    seeHelp: "Run whisprflow help to see all commands.",
    stuck: "It may be stuck. Run whisprflow stop to force it to stop, then run whisprflow to start it again.",
    badArgs: "Invalid arguments: {reason}",
    extraArgs: "Unexpected argument {args}. Usage: {usage}",
    positiveInteger: "{flag} needs a positive integer",
    starting: "Starting WhisprFlow…",
    runRestart: "run whisprflow restart",
    packagedRelaunch: "choose Quit WhisprFlow from the WhisprFlow menu bar icon, then open WhisprFlow.app again",
    syntax: {
      start: "whisprflow start",
      stop: "whisprflow stop",
      restart: "whisprflow restart",
      status: "whisprflow status [--json]",
      history: "whisprflow history [-n count] [--json]",
      usage: "whisprflow usage [--json]",
      logs: "whisprflow logs [-n lines] [-f]",
      settings: "whisprflow settings",
      uninstall: "whisprflow uninstall [--keep-data] [--yes]",
      config: "Usage: whisprflow config | whisprflow config set <name> <value> | whisprflow config unset <name>",
      theme: "Usage: whisprflow theme | whisprflow theme <name>",
      model:
        "Usage: whisprflow model | whisprflow model <provider>[/<model>] | whisprflow model check [<provider>[/<model>]]",
      mode: "Usage: whisprflow mode | whisprflow mode <native|local|private> [--model …] [--transcriber …] [--polish … --url …]",
      transcriber:
        "Usage: whisprflow transcriber | whisprflow transcriber <model> | whisprflow transcriber download|cancel|delete <model> [--yes] | whisprflow transcriber check [<model>]",
      polish:
        "Usage: whisprflow polish | whisprflow polish <provider>[/<model>] [--url <url>] | whisprflow polish check [<provider>[/<model>]]",
    },
    update: {
      fromSource: "This copy runs from source ({dir}): update it with git pull.",
      unreachable: "Couldn't reach {url}: {reason}",
      badVersion: "The download server returned a bad version number: {value}",
      upToDate: "Already up to date ({version}).",
      updating: "Updating WhisprFlow {current} → {latest}",
      updatingApp: "Updating WhisprFlow.app {current} → {latest}",
      appDone: "WhisprFlow.app is now {version}.",
      reopened: "Reopened WhisprFlow.app.",
      appChecksum:
        "The downloaded {file} doesn't match the release; it was probably damaged on the way. Run whisprflow update again.",
      appMount: "Couldn't open the downloaded {file}: {reason}",
      appWrongPackage: "The downloaded {file} doesn't contain WhisprFlow.app {version}, so nothing was installed.",
      appUnsigned: "The downloaded WhisprFlow.app isn't properly signed, so it wasn't installed: {reason}",
      appOtherDeveloper:
        "The downloaded WhisprFlow.app is signed by a different developer ({found}; the installed one is {installed}), so it wasn't installed.",
      appReplace: "Couldn't replace {path}: {reason}. You can download {url} and drag it into Applications yourself.",
      available: "WhisprFlow {latest} is out (you have {current}): run whisprflow update.",
    },

    lifecycle: {
      openedOnboarding:
        "Opened the setup guide. Grant the missing permissions there, then run whisprflow status to check.",
      openedSettings: "Opened Settings. Grant the missing permissions there, then run whisprflow status to check.",
      notRunning: "WhisprFlow wasn't running.",
      stopped: "WhisprFlow stopped.",
      killed: "WhisprFlow was stuck and has been force-quit.",
      packagedRestart:
        "The running WhisprFlow is WhisprFlow.app in Applications. Restarting it from the command line would swap in a terminal-launched copy with separate permissions and keys.",
      howToRestart: "To restart it: {relaunch}.",
    },
    key: {
      prompt: "Paste the key and press Enter (input is hidden): ",
      need: "WhisprFlow needs a {provider} API key: recordings are sent to {provider} to become text.",
      getOne: "Don't have one? Get one here: {url}",
      storage: "It's encrypted with the system keychain and stays on this Mac.",
      skip: "Press Enter to skip for now.",
      verifying: "Verifying…",
      notNeeded: "{provider} runs on this computer and needs no key.",
      saved: "Key saved and verified.",
      rejected: "This key didn't pass: {problem}",
      notInline:
        "Don't put the key after the command: it would stay in your shell history. Run whisprflow key and paste it, or pipe it in: pbpaste | whisprflow key. To set one for a specific provider, add its name: {providers}",
      forgotten: "Deleted the saved {provider} key.",
      whichVendor: "Private mode doesn't use a key. To set one for a provider, add its name: {providers}",
      cancelled: "Cancelled; the key is unchanged.",
      nothingRead: "No key read; the old one is unchanged.",
      badShapeUnchanged: "{problem}. The old one is unchanged.",
      switchHint: "To use it: {command}",
      needText:
        "You need a {provider} API key: recordings are transcribed on this computer, and only the text goes to {provider} for polishing.",
      customWithModel:
        "A custom service's key goes in together with its model and address: whisprflow polish custom/<model> --url <url> (not in local mode yet: whisprflow mode local --polish custom/<model> --url <url>)",
    },
    config: {
      nextLaunch: "Takes effect next launch.",
      packaged: "The running WhisprFlow is WhisprFlow.app in Applications. To apply the new settings: {relaunch}.",
      restarting: "Restarting WhisprFlow to apply…",
      restartedBroken: "Restarted, but it can't be used now: {problem}",
      undo: "To undo this change: {undo}",
      restartedKeyBad:
        "Restarted, but the {provider} key doesn't work: {problem}. Run whisprflow key {id} to replace it",
      restartedNoKey: "Restarted, but there's no {provider} key yet, so it can't be used: run whisprflow key {id}",
      restartedStarting: "Restarted, but not ready yet: run whisprflow status to check.",
      restartedUnverified:
        "Restarted, but couldn't reach {provider}, so the new settings aren't verified yet: run whisprflow status in a bit.",
      applied: "Applied.",
      oldDaemonLive: "The running WhisprFlow is an old version and won't switch on the fly: run whisprflow restart.",
      appliedLive: "Applied, no restart needed.",
      themeOverridden:
        "The running WhisprFlow still uses {theme}: {variable} is set where it was started, and it overrides the settings file.",
      languageOverridden:
        "The running WhisprFlow still uses {language}: {variable} is set where it was started, and it overrides the settings file.",
      modelSourceOverridden:
        "The running WhisprFlow still uses {source}: {variable} is set where it was started, and it overrides the settings file.",
      envWarning: "Note: the {variable} env var is set and overrides this value.",
      changed: "{name} set to {value}.",
      modeCommand:
        "This is usually changed with {command}, which checks it works first and leaves it alone if not. config set skips the checks and writes it straight in.",
      otherMode: "You're in {current} mode now; this takes effect when you switch to {mode} mode.",
      unset: "{name} reset to the default, {value}.",
      themeChanged: "Theme set to {theme}.",
      notRunning: "WhisprFlow isn't running. Run whisprflow to start it first.",
      settingsOpened: "Settings opened.",
      title: "Settings",
      choices: "{describe}. Options: {choices}",
      hintSet: "Change one: whisprflow config set hotkey fn",
      hintUnset: "Reset one: whisprflow config unset hotkey",
      hintKey: "Replace the key: whisprflow key",
      hintTheme: "Switch theme: whisprflow theme",
      folder: "Folder",
      settingsFile: "Settings file",
      log: "Log",
      oneFolder: "The program, settings, keys, history, and recordings all live in this one folder.",
      uninstallHint: "Done with it? whisprflow uninstall stops it and deletes the whole folder.",
    },
    source: {
      default: "default",
      file: "from the settings file",
      env: "from the {variable} env var this run",
    },
    themeTitle: "{name} ({id})",
    themes: {
      title: "Themes",
      current: "Using {theme} · {source}",
      switch: "Switch: whisprflow theme {id} (applies right away, no restart)",
    },
    modes: {
      title: "Recognition modes",
      notIn: "You're in {current} mode; {what} can only be changed in {mode} mode: run whisprflow mode {mode} first",
      notSwitched: "Not switched: {problem}",
      applied: "Switched, no restart needed.",
      notUsable: "But it doesn't work yet: {problem}",
      downloading:
        "The local model is downloading in the background ({percent}%); it'll work once it's done. Progress: whisprflow status",
      loading: "The local model is loading; a few seconds.",
      switch: "Switch: whisprflow mode {mode} (takes effect right away)",
      nativeModels: "Change the model in native: whisprflow model",
      localHops:
        "The two steps of local: whisprflow transcriber (step 1, on-device) · whisprflow polish (step 2, polishing)",
      withSettings:
        "Use a custom service on first entering local: whisprflow mode local --polish custom/<model> --url <url>",
      flagsFor: "{flag} isn't a {mode} setting; switching to {mode} can bring {flags}",
      already: "Already in {mode} mode: {route}.",
      switched: "Switched to {mode} mode: {route}.",
      localRoute: "{transcriber} → {polish}",
      privateRoute: "{transcriber} on this computer; no polishing, nothing uploaded",
      privateModel: "The on-device model in private: whisprflow transcriber (on-device models only)",
    },
    local: {
      notInLocal: "You're in {current} mode, so these aren't in use: switch first (whisprflow mode local or private)",
      cloudNoDownload: "{model} is a cloud model; there's nothing to download",
      cloudCheckOk: "{model} works; the request took {seconds}.",
      transcribersTitle: "On-device transcription models (step 1 of local, the model of private)",
      installed: "downloaded",
      notInstalled: "not downloaded",
      downloading: "downloading {percent}%",
      partial: "{percent}% downloaded",
      downloadFailed: "download failed",
      summary: "{count} of {all} downloaded on this computer, {size} in total",
      freeSpace: "{size} free on disk",
      transcriberCurrent: "In use: {model}",
      transcriberSwitch: "Switch: whisprflow transcriber {id}",
      transcriberManage:
        "Download: whisprflow transcriber download {id} · stop: cancel · remove: delete · check: check",
      downloadStart: "Downloading {model} ({size}, from {source})…",
      downloadBackground:
        "WhisprFlow is downloading it in the background: Ctrl-C only stops watching; to stop the download, run whisprflow transcriber cancel {id}",
      downloadProgress: "Downloading {percent}% ({received} / {total})",
      downloadDone: "{model} is downloaded.",
      downloadAlready: "{model} is already downloaded.",
      downloadStopped:
        "The {model} download stopped (cancelled elsewhere). Finished files are kept; a half-done file starts over next time.",
      downloadInterrupted:
        "WhisprFlow quit during the download. Finished files are kept; run whisprflow transcriber download {id} to continue.",
      nothingToCancel: "{model} isn't downloading.",
      cancelled: "Stopped downloading {model}. Finished files are kept; a half-done file starts over next time.",
      notOnDisk: "{model} isn't downloaded, so there's nothing to delete.",
      deleteConfirm: "Delete {model} ({size})? You'll need to download it again to use it. Type y to confirm: ",
      deleteNeedsConfirm:
        "Deleting needs confirmation: run it in a terminal, or add --yes (whisprflow transcriber delete {id} --yes)",
      deleteAborted: "Nothing deleted.",
      deleted: "Deleted {model}, freeing {size}.",
      oldDaemonDelete:
        "The running WhisprFlow is an old version that can't tell which model is in use, so nothing was deleted: run whisprflow restart, then try again.",
      checking: "Checking {model}: reading it a sentence…",
      checkOk: "{model} works. Read '{said}', got '{text}', transcribed in {seconds}.",
      checkLoaded: "It wasn't in use: loading it took {seconds}, and it's unloaded again.",
      oldDaemonCheck:
        "The running WhisprFlow is an old version that can't check on-device models: run whisprflow restart, then check again.",
      notDownloadedAsk: "{model} isn't downloaded yet ({size}, from {source}). Download it now? Type y to download: ",
      notDownloadedHint: "{model} isn't downloaded yet: run whisprflow transcriber download {id} first",
      notDownloadedLater:
        "Nothing downloaded or switched. To download it later, run whisprflow transcriber download {id}",
      transcriberSwitched: "Step 1 is now {model}.",
      polishTitle: "Polishing models (local mode, step 2)",
      customName: "Custom service",
      customModel: "your own model and address",
      alsoModels: "also: {models}",
      polishCurrent: "In use: {model}",
      polishSwitch: "Switch: whisprflow polish ollama/qwen3:4b-instruct",
      polishCustom: "Custom service (OpenAI-compatible): whisprflow polish custom/<model> --url <url>",
      polishCheck: "Check it works: whisprflow polish check",
      polishSwitched: "Step 2 is now {model}.",
      urlNeeded: "A custom polishing service needs its address: --url <url> (OpenAI-compatible; most end in /v1)",
      sourceCurrent: "Downloads from: {source}",
      sourceSwitch: "Change: whisprflow config set modelSource {other} (falls back to the other if one stalls)",
    },
    choose: {
      question: "First, pick how recordings become text (change it later with whisprflow mode or whisprflow model):",
      native: "native mode: the recording goes straight to the model",
      local:
        "local mode: transcribed on this computer, only the text goes to a model for polishing (first use downloads a {size} local model)",
      private:
        "private mode: transcribed on this computer only; no polishing, nothing uploaded (first use downloads a {size} local model)",
      privateOption: "Private    no key needed",
      custom:
        "  To use another service (OpenAI-compatible): after setup, run whisprflow mode local --polish custom/<model> --url <url>",
    },
    model: {
      textOnly:
        "{provider} only takes text; it's step 2 of local mode: whisprflow polish {id} (not in local mode yet? whisprflow mode local first)",
      notInNative:
        "You're in {current} mode, so these models aren't in use: switch back first (whisprflow mode native)",
      unknownProvider: "Unknown provider {name}; available: {providers}. To pick a model, write provider/model",
      invalid: "Model is {value}: {reason}",
      describe: "{provider} {model}",
      option: "default {model}",
      optionWithKey: "default {model}, key already set",
      optionLocal: "default {model}, runs on this computer, no key needed",
      choose: "First, pick whose model turns your recordings into text (change it later with whisprflow model):",
      choosePrompt: "Enter a number and press Enter (just Enter picks {fallback}): ",
      choosePromptAgain: "Enter a number and press Enter: ",
      choiceItem: "{number} ({name})",
      noSuchChoice: "There's no option {answer}; choose {choices}.",
      noKeyNonInteractive: "No {provider} key yet, so nothing changed: run whisprflow key {id} first, then switch.",
      notSwitched: "Not switched: no {provider} key yet.",
      switched: "Model switched to {model}.",
      checking: "Checking {model}…",
      oldDaemonCheck:
        "The running WhisprFlow is an old version and can't check: run whisprflow restart, then check again.",
      unusable: "Not usable: {problem}",
      usable: "Works: {model}, using {from}, round trip {seconds}s.",
      fromEnv: "the key in the {variable} env var",
      fromStored: "the saved key",
    },
    models: {
      title: "Models",
      default: "{model} (default)",
      keyStored: "key saved",
      keyEnv: "key from the {variable} env var",
      noKey: "no key yet",
      current: "Using {provider} {model} · {source}",
      switch: "Switch provider: whisprflow model {id} (asks for its key if missing)",
      pick: "Pick a model: whisprflow model {id}/{model}",
      check: "Check it works: whisprflow model check (no argument checks the current one)",
    },
    status: {
      notRunning: "not running",
      runToStart: "Run {command} to start it.",
      starting: "starting",
      running: "running",
      missingCount: { one: "running, {count} thing missing", other: "running, {count} things missing" },
      preparing: "running, getting ready",
      ready:
        "Ready: click into any text box, press {hotkey} to start talking, press it again to finish, and the text gets pasted in.",
      missing: "Missing: {items}.",
      key: "Key",
      permissions: "Permissions",
      hotkey: "Hotkey",
      model: "Model",
      theme: "Theme",
      language: "Language",
      today: "Today",
      total: "All time",
      modelExternal: "decided by the separately started server",
      mode: "Mode",
      localModel: "Local model",
      localReady: "ready · {backend}",
      localDownloading: "downloading {percent}% ({received} / {total} MB)",
      localLoading: "loading",
      localMissing: "not downloaded: whisprflow transcriber download {id}",
      modelInUse: "{provider} {model}",
      modelWithThinking: "{provider} {model} ({thinking})",
      keyEnv: "Using the one in the {variable} env var this run, not saved",
      keyEnvUnverified:
        "Using the one in the {variable} env var this run, not saved; couldn't reach {provider} at launch, so it isn't verified yet",
      keyExternal: "Connected to a separately started server; the key is set there",
      keyNone: "Not needed",
      keySaved: "Saved and verified",
      keySavedUnverified: "Saved; couldn't reach {provider} at launch, so it isn't verified yet",
      keyChecking: "Verifying…",
      keyCheckFailed: "Check failed: {problem}. The key may be fine; check the {what} first: whisprflow config",
      modelAndLevel: "model and thinking level",
      modelOnly: "model",
      keyEnvRejected:
        "The key in the {variable} env var doesn't work: {problem}. Fix it or remove the variable, then restart",
      keyRejected: "Not working: {problem}. Run whisprflow key to replace it",
      keyUnreadable: "{problem}: run whisprflow key",
      keyMissing: "Not set: run whisprflow key",
      keyMissingFor: "{provider} key not set: run whisprflow key {id}",
      dictations: { one: "{count} dictation", other: "{count} dictations" },
      words: { one: "{count} word", other: "{count} words" },
      pace: "{count} words/min",
      atLeast: "at least {cost}",
      costUnknown: "cost unknown",
      pending: "Changed in settings but not applied yet ({names}): {relaunch}.",
      helperStopped:
        "The key-listening helper stopped, so the hotkey won't work: {relaunch}. If it keeps happening, see whisprflow logs.",
      openSettings:
        "Run {command} to open the permissions page in Settings: each permission has a button to System Settings; after turning it on, click Check again.",
      ownerApp: "Permissions belong to the app itself; look for WhisprFlow in the System Settings lists.",
      ownerTerminal:
        "Permissions belong to the terminal app that started WhisprFlow (e.g. Terminal or iTerm); look for it in the System Settings lists.",
      footer: `whisprflow history  what you said     whisprflow config  view and change settings
whisprflow usage    what it cost      whisprflow stop    stop it
whisprflow help     all commands`,
    },
    history: {
      empty: "No dictations yet. Run {command} to start, then press the hotkey and say something.",
      today: "Today · {date}",
      yesterday: "Yesterday · {date}",
      failed: "✗ Failed: {reason}",
      recording: "Recording {seconds}s, kept at {path}",
      notSaved: "(not saved)",
      more: "Showing the latest {shown} of {total}. Run whisprflow history -n {total} to see all.",
    },
    usage: {
      empty: "No usage yet. Say something first: every model call's cost, tokens, and reply time get recorded.",
      title: "Usage",
      cost: "Cost",
      tokens: "Tokens",
      dictations: "Dictations",
      latency: "Model reply",
      waiting: "usually {median}, slow {slow}",
      usually: "usually {median}",
      unpriced: "price unknown",
      localModel: "{name} (on-device)",
      free: "free",
      times: { one: "{count} dictation", other: "{count} dictations" },
      byModel: "By model (all time)",
      tokensNote:
        "All-time tokens: input {input} (audio {audio}, cached {cached}), output {output} (thinking {thinking}).",
      checksNote: { one: "Includes {count} key check.", other: "Includes {count} key checks." },
      cacheNote: "{cost} of the cost is prompt caching (creating and keeping it).",
      unpricedNote: "Not in the price list: {models}. Those {count} calls aren't counted.",
      estimateNote:
        "Costs are USD estimates at each provider's standard price; Gemini use within the free tier is actually free.",
    },
    logs: {
      none: "No logs yet: WhisprFlow writes them to {file} once it has started",
    },
    uninstall: {
      yours: "settings, keys, history, and recordings",
      needsConfirm: "Uninstalling needs confirmation. Add --yes when not running in a terminal.",
      planKeep: "About to uninstall WhisprFlow: delete the program and runtime in {home}, keeping your {yours}.",
      planAll:
        "About to uninstall WhisprFlow: delete all of {home}, including the program, runtime, and your {yours}. This can't be undone.",
      confirm: "Are you sure? Type y and press Enter: ",
      aborted: "Nothing changed.",
      removedKeep: "the program, runtime, logs, and cache in {home}",
      keychainItem: "the keychain item used to encrypt keys",
      keychainFailed:
        "The keychain item used to encrypt keys wasn't deleted ({reason}): search for WhisprFlow in Keychain Access and delete it by hand",
      pathEntry: "{entry} in your user Path",
      loginItem: "Open at login",
      afterExit: "The program files are in use by this command; they're removed a few seconds after it exits",
      removedAll: "{home} (the program, runtime, and your {yours})",
      done: "WhisprFlow uninstalled.",
      removed: "Deleted: {item}",
      kept: "Kept: your {yours} in {home}. Reinstall to pick up where you left off; delete the folder if you don't need them",
      leftovers: "Still on your system:",
      permissions:
        "Microphone, Input Monitoring, and Accessibility access for your terminal is untouched: it belongs to the terminal app and can be turned off in System Settings › Privacy & Security",
      sharedPrefs:
        "{file} is untouched: a small file where the runtime remembers things like window sizes, shared by every app built on stock Electron",
      sourceDir: "Source folder is untouched: {dir}",
    },
    daemon: {
      noElectron: "Can't find Electron: dependencies aren't fully installed. Run npm install in {dir} and try again.",
      downloading: "First launch: downloading the Electron runtime (about 100 MB)…",
      downloadFailed: "Electron didn't download ({reason}). Check your network and run this again.",
      emptyLog: "(the log is empty)",
      micPrompt: "macOS is asking for microphone access: click Allow (the dialog shows your terminal app's name).",
      verifying: "Verifying key…",
      building: "First launch: building the key-listening helper…",
      signal: "ended by signal {signal}",
      exitCode: "exit code {code}",
      exitedEarly: "exited midway",
      failed: "WhisprFlow failed to start ({reason}). Last lines of the log {file}:\n{tail}",
      noAnswer: "WhisprFlow didn't respond within {seconds} seconds of starting. Check the log: {file}",
      stuckNoPid:
        "WhisprFlow is stuck and not answering, and its process can't be identified. Find the process named Electron or WhisprFlow in Activity Monitor and quit it.",
      cantStop: "Can't stop WhisprFlow (PID {pid}). Quit it in Activity Monitor.",
      needXcode:
        "Building the key-listening helper needs the Xcode Command Line Tools. Run this first: xcode-select --install",
      buildFailed:
        "The key-listening helper didn't build (if the Xcode Command Line Tools aren't installed, run xcode-select --install first):\n{detail}",
      needGo:
        "Running from source on Windows, building the key-listening helper needs Go 1.27 or newer (https://go.dev/dl/). Install it, then start again.",
      buildFailedGo: "The Windows key-listening helper didn't build:\n{detail}",
    },
  },

  // The sentences worded differently on Windows, under the same names as the general ones (see the top of src/i18n/index.mjs)
  windows: {
    cli: {
      daemon: {
        stuckNoPid:
          "WhisprFlow is stuck and not answering, and its process can't be identified. In Task Manager's Details tab, find electron.exe and end it.",
        cantStop: "Can't stop WhisprFlow (PID {pid}). End it in Task Manager.",
      },
      key: { storage: "It's encrypted with Windows data protection and stays on this PC." },
    },
    permissions: { openSettings: "Settings" },
    settings: {
      describe: {
        mode: "Which way to recognize speech: native sends the recording to a model that takes audio; local transcribes on this PC first, then has any LLM polish the text; private only transcribes on this PC and uploads nothing",
        language: "Interface language; system follows Windows",
      },
    },
    modes: {
      local: "Local: transcribed on this PC, then polished by a model",
      private: "Private: transcribed on this PC only, nothing uploaded",
    },
    setup: { openSettings: "tray icon › Settings" },
    key: {
      keychainUnavailable: "Windows' encrypted storage isn't available, so the key can't be stored safely",
      noKeyService:
        "No {provider} API key yet: run whisprflow key in a terminal, or open Settings from the WhisprFlow icon in the taskbar tray",
      noKeyServiceFor:
        "No {provider} API key yet: run whisprflow key {id} in a terminal, or open Settings from the WhisprFlow icon in the taskbar tray",
    },
    delivery: { pasteFailed: "Couldn't paste: text copied, press Ctrl+V to paste" },
    bar: { noMicPermission: "No microphone access: Settings › Privacy & security › Microphone" },
    plaza: {
      via: { local: "This PC" },
      toolbar: { keysLocal: "Keys stay on this PC" },
      groups: {
        local: "On this PC",
        localMeta: "Audio stays on this PC · {done}/{total} downloaded",
        localMetaFree: "Audio stays on this PC · {done}/{total} downloaded · {free} free",
      },
    },
    onboarding: {
      permissions: {
        // Windows only has the microphone permission
        soft: "Check ",
        title: "microphone access",
        history: "History stays on this PC",
        key: "Key encrypted on this PC",
      },
      microphone: { help: "Check the input device and volume in Settings › System › Sound, or turn on" },
    },
  },
};
