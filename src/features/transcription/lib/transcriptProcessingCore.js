let wasm;
let dataView = null;
let float32Memory = null;
let uint8Memory = null;
let lastVectorLength = 0;

const heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);
let heapNext = heap.length;
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const textEncoder = new TextEncoder();
const registry =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) => wasm.__wbg__0x2b_free(ptr >>> 0, 1));

/**
 * @param {string | URL} [moduleOrPath]
 */
export async function initTranscriptProcessingCore(
  moduleOrPath = "/wasm/transcript-processing-core_bg.wasm",
) {
  if (wasm) return wasm;
  const imports = buildImports();
  const source =
    typeof moduleOrPath === "string" || moduleOrPath instanceof URL
      ? fetch(moduleOrPath)
      : moduleOrPath;
  const { instance } = await instantiate(await source, imports);
  wasm = instance.exports;
  dataView = null;
  float32Memory = null;
  uint8Memory = null;
  return wasm;
}

/**
 * @param {Float32Array} audioSamples
 * @returns {Float32Array}
 */
export function computeMelSpectrogram(audioSamples) {
  ensureInitialized();
  try {
    const stackPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
    const ptr = passFloat32Array(audioSamples);
    const len = lastVectorLength;
    wasm._0x1a(stackPointer, ptr, len);
    const retPtr = getDataView().getInt32(stackPointer, true);
    const retLen = getDataView().getInt32(stackPointer + 4, true);
    const result = getFloat32Memory()
      .subarray(retPtr / 4, retPtr / 4 + retLen)
      .slice();
    wasm.__wbindgen_export4(retPtr, 4 * retLen, 4);
    return result;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

/**
 * @param {Array<{ text: string, start: number, end: number, confidence?: number, utteranceId?: number }>} words
 */
export function prepareWords(words) {
  ensureInitialized();
  return takeObject(wasm._0x6f(addHeapObject(words)));
}

/**
 * @param {unknown} preparedWords
 * @param {unknown} diarizationLabels
 * @param {boolean} skipDiarize
 */
export function constructSentences(
  preparedWords,
  diarizationLabels,
  skipDiarize,
) {
  ensureInitialized();
  return takeObject(
    wasm._0x4d(
      addHeapObject(preparedWords),
      addHeapObject(diarizationLabels),
      skipDiarize,
    ),
  );
}

/**
 * @param {Array<{ start: number, end: number }>} vadSegments
 * @param {number} maxDurationSeconds
 * @param {number} paddingSeconds
 * @returns {Array<{ start: number, end: number }>}
 */
export function createVadChunks(
  vadSegments,
  maxDurationSeconds = 90,
  paddingSeconds = 3,
) {
  ensureInitialized();
  const result = takeObject(
    wasm._0x3c(addHeapObject(vadSegments), maxDurationSeconds, paddingSeconds),
  );
  return Array.isArray(result)
    ? result
        .map((chunk) => ({
          start: Number(chunk.start),
          end: Number(chunk.end),
        }))
        .filter(
          (chunk) =>
            Number.isFinite(chunk.start) &&
            Number.isFinite(chunk.end) &&
            chunk.end > chunk.start,
        )
    : [];
}

export class SortformerProcessor {
  __wbg_ptr = 0;

  constructor() {
    ensureInitialized();
    const ptr = wasm.sortformerprocessor_new();
    this.__wbg_ptr = ptr >>> 0;
    registry.register(this, this.__wbg_ptr, this);
  }

  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg__0x2b_free(ptr, 0);
  }

  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    registry.unregister(this);
    return ptr;
  }

  getSpeakerCache() {
    return readProcessorFloatArray((stackPointer) => {
      wasm.sortformerprocessor_g_sc(stackPointer, this.__wbg_ptr);
    });
  }

  getSpeakerCacheLength() {
    return wasm.sortformerprocessor_g_scl(this.__wbg_ptr) >>> 0;
  }

  getFifo() {
    return readProcessorFloatArray((stackPointer) => {
      wasm.sortformerprocessor_g_f(stackPointer, this.__wbg_ptr);
    });
  }

  getFifoLength() {
    return wasm.sortformerprocessor_g_fl(this.__wbg_ptr) >>> 0;
  }

  /**
   * @param {Float32Array} predictions
   * @param {Float32Array} embeddings
   * @param {number} actualFrameCount
   */
  processChunk(predictions, embeddings, actualFrameCount) {
    ensureInitialized();
    try {
      const stackPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
      const predPtr = passFloat32Array(predictions);
      const predLen = lastVectorLength;
      const embPtr = passFloat32Array(embeddings);
      const embLen = lastVectorLength;
      wasm.sortformerprocessor_p_c(
        stackPointer,
        this.__wbg_ptr,
        predPtr,
        predLen,
        embPtr,
        embLen,
        actualFrameCount,
      );
      const retPtr = getDataView().getInt32(stackPointer, true);
      const retLen = getDataView().getInt32(stackPointer + 4, true);
      const result = getFloat32Memory()
        .subarray(retPtr / 4, retPtr / 4 + retLen)
        .slice();
      wasm.__wbindgen_export4(retPtr, 4 * retLen, 4);
      return result;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  /**
   * @param {Float32Array} predictions
   */
  finalizeAssignment(predictions) {
    ensureInitialized();
    const ptr = passFloat32Array(predictions);
    const len = lastVectorLength;
    return takeObject(wasm.sortformerprocessor_f_z(this.__wbg_ptr, ptr, len));
  }
}

/**
 * @param {(stackPointer: number) => void} invoke
 */
function readProcessorFloatArray(invoke) {
  try {
    const stackPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
    invoke(stackPointer);
    const ptr = getDataView().getInt32(stackPointer, true);
    const len = getDataView().getInt32(stackPointer + 4, true);
    const result = getFloat32Memory()
      .subarray(ptr / 4, ptr / 4 + len)
      .slice();
    wasm.__wbindgen_export4(ptr, 4 * len, 4);
    return result;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

/**
 * @param {Response | WebAssembly.Module | Promise<Response>} source
 * @param {WebAssembly.Imports} imports
 */
async function instantiate(source, imports) {
  if (typeof Response === "function" && source instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(source, imports);
      } catch (err) {
        if (
          !source.ok ||
          source.headers.get("Content-Type") === "application/wasm"
        ) {
          throw err;
        }
      }
    }
    return await WebAssembly.instantiate(await source.arrayBuffer(), imports);
  }
  const result = await WebAssembly.instantiate(source, imports);
  return result instanceof WebAssembly.Instance
    ? { instance: result, module: source }
    : result;
}

function buildImports() {
  return {
    // The served `/wasm/transcript-processing-core_bg.wasm` asset was
    // originally sourced from transcrisper.com as `transcrisper-core_bg.wasm`
    // and compiled with wasm-bindgen. The import module key below, `./transcrisper-core_bg.js`,
    // is part of that generated WASM contract, so keep the upstream name.
    "./transcrisper-core_bg.js": {
      __wbg_Error_83742b46f01ce22d: (ptr, len) =>
        addHeapObject(Error(getString(ptr, len))),
      __wbg_Number_a5a435bd7bbec835: (idx) => Number(getObject(idx)),
      __wbg___wbindgen_bigint_get_as_i64_447a76b5c6ef7bda: (ptr, idx) => {
        const value = getObject(idx);
        const bigint = typeof value === "bigint" ? value : undefined;
        getDataView().setBigInt64(
          ptr + 8,
          isLikeNone(bigint) ? BigInt(0) : bigint,
          true,
        );
        getDataView().setInt32(ptr, !isLikeNone(bigint), true);
      },
      __wbg___wbindgen_boolean_get_c0f3f60bac5a78d1: (idx) => {
        const value = getObject(idx);
        return typeof value === "boolean" ? (value ? 1 : 0) : 0xffffff;
      },
      __wbg___wbindgen_debug_string_5398f5bb970e0daa: (ptr, idx) => {
        const debug = debugString(getObject(idx));
        const strPtr = passString(
          debug,
          wasm.__wbindgen_export,
          wasm.__wbindgen_export2,
        );
        getDataView().setInt32(ptr + 4, lastVectorLength, true);
        getDataView().setInt32(ptr, strPtr, true);
      },
      __wbg___wbindgen_in_41dbb8413020e076: (key, object) =>
        getObject(key) in getObject(object),
      __wbg___wbindgen_is_bigint_e2141d4f045b7eda: (idx) =>
        typeof getObject(idx) === "bigint",
      __wbg___wbindgen_is_function_3c846841762788c1: (idx) =>
        typeof getObject(idx) === "function",
      __wbg___wbindgen_is_object_781bc9f159099513: (idx) => {
        const value = getObject(idx);
        return typeof value === "object" && value !== null;
      },
      __wbg___wbindgen_is_undefined_52709e72fb9f179c: (idx) =>
        getObject(idx) === undefined,
      __wbg___wbindgen_jsval_eq_ee31bfad3e536463: (a, b) =>
        getObject(a) === getObject(b),
      __wbg___wbindgen_jsval_loose_eq_5bcc3bed3c69e72b: (a, b) =>
        getObject(a) == getObject(b),
      __wbg___wbindgen_number_get_34bb9d9dcfa21373: (ptr, idx) => {
        const value = getObject(idx);
        const number = typeof value === "number" ? value : undefined;
        getDataView().setFloat64(
          ptr + 8,
          isLikeNone(number) ? 0 : number,
          true,
        );
        getDataView().setInt32(ptr, !isLikeNone(number), true);
      },
      __wbg___wbindgen_string_get_395e606bd0ee4427: (ptr, idx) => {
        const value = getObject(idx);
        const str = typeof value === "string" ? value : undefined;
        const strPtr = isLikeNone(str)
          ? 0
          : passString(str, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        getDataView().setInt32(ptr + 4, lastVectorLength, true);
        getDataView().setInt32(ptr, strPtr, true);
      },
      __wbg___wbindgen_throw_6ddd609b62940d55: (ptr, len) => {
        throw new Error(getString(ptr, len));
      },
      __wbg_call_e133b57c9155d22c: (fn, thisArg) =>
        handleError(() =>
          addHeapObject(getObject(fn).call(getObject(thisArg))),
        ),
      __wbg_done_08ce71ee07e3bd17: (idx) => getObject(idx).done,
      __wbg_get_326e41e095fb2575: (object, key) =>
        handleError(() =>
          addHeapObject(Reflect.get(getObject(object), getObject(key))),
        ),
      __wbg_get_unchecked_329cfe50afab7352: (idx, index) =>
        addHeapObject(getObject(idx)[index >>> 0]),
      __wbg_get_with_ref_key_6412cf3094599694: (object, key) =>
        addHeapObject(getObject(object)[getObject(key)]),
      __wbg_instanceof_ArrayBuffer_101e2bf31071a9f6: (idx) => {
        try {
          return getObject(idx) instanceof ArrayBuffer;
        } catch {
          return false;
        }
      },
      __wbg_instanceof_Uint8Array_740438561a5b956d: (idx) => {
        try {
          return getObject(idx) instanceof Uint8Array;
        } catch {
          return false;
        }
      },
      __wbg_isArray_33b91feb269ff46e: (idx) => Array.isArray(getObject(idx)),
      __wbg_isSafeInteger_ecd6a7f9c3e053cd: (idx) =>
        Number.isSafeInteger(getObject(idx)),
      __wbg_iterator_d8f549ec8fb061b1: () => addHeapObject(Symbol.iterator),
      __wbg_length_b3416cf66a5452c8: (idx) => getObject(idx).length,
      __wbg_length_ea16607d7b61445b: (idx) => getObject(idx).length,
      __wbg_new_5f486cdf45a04d78: (idx) =>
        addHeapObject(new Uint8Array(getObject(idx))),
      __wbg_new_a70fbab9066b301f: () => addHeapObject([]),
      __wbg_new_ab79df5bd7c26067: () => addHeapObject({}),
      __wbg_next_11b99ee6237339e3: (idx) =>
        handleError(() => addHeapObject(getObject(idx).next())),
      __wbg_next_e01a967809d1aa68: (idx) => addHeapObject(getObject(idx).next),
      __wbg_prototypesetcall_d62e5099504357e6: (ptr, len, source) => {
        Uint8Array.prototype.set.call(
          getUint8Memory().subarray(ptr, ptr + len),
          getObject(source),
        );
      },
      __wbg_random_5bb86cae65a45bf6: () => Math.random(),
      __wbg_set_282384002438957f: (idx, prop, value) => {
        getObject(idx)[prop >>> 0] = takeObject(value);
      },
      __wbg_set_6be42768c690e380: (idx, key, value) => {
        getObject(idx)[takeObject(key)] = takeObject(value);
      },
      __wbg_value_21fc78aab0322612: (idx) =>
        addHeapObject(getObject(idx).value),
      __wbindgen_cast_0000000000000001: (value) => addHeapObject(value),
      __wbindgen_cast_0000000000000002: (ptr, len) =>
        addHeapObject(getString(ptr, len)),
      __wbindgen_cast_0000000000000003: (value) =>
        addHeapObject(BigInt.asUintN(64, value)),
      __wbindgen_object_clone_ref: (idx) => addHeapObject(getObject(idx)),
      __wbindgen_object_drop_ref: (idx) => {
        takeObject(idx);
      },
    },
  };
}

function ensureInitialized() {
  if (!wasm)
    throw new Error("Transcript processing WASM core is not initialized");
}

function getDataView() {
  if (!dataView || dataView.buffer !== wasm.memory.buffer) {
    dataView = new DataView(wasm.memory.buffer);
  }
  return dataView;
}

function getFloat32Memory() {
  if (!float32Memory || float32Memory.buffer !== wasm.memory.buffer) {
    float32Memory = new Float32Array(wasm.memory.buffer);
  }
  return float32Memory;
}

function getUint8Memory() {
  if (!uint8Memory || uint8Memory.buffer !== wasm.memory.buffer) {
    uint8Memory = new Uint8Array(wasm.memory.buffer);
  }
  return uint8Memory;
}

function addHeapObject(obj) {
  if (heapNext === heap.length) heap.push(heap.length + 1);
  const idx = heapNext;
  heapNext = heap[idx];
  heap[idx] = obj;
  return idx;
}

function getObject(idx) {
  return heap[idx];
}

function dropObject(idx) {
  if (idx < 1028) return;
  heap[idx] = heapNext;
  heapNext = idx;
}

function takeObject(idx) {
  const ret = getObject(idx);
  dropObject(idx);
  return ret;
}

function passFloat32Array(array) {
  const ptr = wasm.__wbindgen_export(4 * array.length, 4) >>> 0;
  getFloat32Memory().set(array, ptr / 4);
  lastVectorLength = array.length;
  return ptr;
}

function passString(value, malloc, realloc) {
  if (realloc === undefined) {
    const bytes = textEncoder.encode(value);
    const ptr = malloc(bytes.length, 1) >>> 0;
    getUint8Memory()
      .subarray(ptr, ptr + bytes.length)
      .set(bytes);
    lastVectorLength = bytes.length;
    return ptr;
  }
  let len = value.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8Memory();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = value.charCodeAt(offset);
    if (code > 0x7f) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) value = value.slice(offset);
    ptr = realloc(ptr, len, (len = offset + value.length * 3), 1) >>> 0;
    const view = getUint8Memory().subarray(ptr + offset, ptr + len);
    const ret = textEncoder.encodeInto(value, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  lastVectorLength = offset;
  return ptr;
}

function getString(ptr, len) {
  return textDecoder.decode(getUint8Memory().subarray(ptr, ptr + len));
}

function handleError(fn) {
  try {
    return fn();
  } catch (err) {
    wasm.__wbindgen_export3(addHeapObject(err));
    return 0;
  }
}

function isLikeNone(value) {
  return value === undefined || value === null;
}

function debugString(value) {
  const type = typeof value;
  if (type === "number" || type === "boolean" || value == null)
    return `${value}`;
  if (type === "string") return `"${value}"`;
  if (type === "symbol")
    return value.description == null
      ? "Symbol"
      : `Symbol(${value.description})`;
  if (type === "function")
    return value.name ? `Function(${value.name})` : "Function";
  if (Array.isArray(value)) return `[${value.map(debugString).join(", ")}]`;
  try {
    return `Object(${JSON.stringify(value)})`;
  } catch {
    return "Object";
  }
}
