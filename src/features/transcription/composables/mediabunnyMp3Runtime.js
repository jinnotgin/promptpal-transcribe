import {
  AudioSample,
  AudioSampleSource,
  Mp3OutputFormat,
  Output,
  StreamTarget,
} from "mediabunny";
import { registerMp3Encoder } from "@mediabunny/mp3-encoder";

registerMp3Encoder();

export {
  AudioSample,
  AudioSampleSource,
  Mp3OutputFormat,
  Output,
  StreamTarget,
};
