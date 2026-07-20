import { useState, useEffect, useRef, useCallback } from 'react';

/*
 * useVoice — browser-native voice mode for the AI hub.
 *
 * Text-to-speech (read coach/assistant replies aloud) with a choice of system
 * voices, plus optional speech-to-text dictation. Everything runs client-side
 * through the Web Speech API, so there's no backend, API key, or extra cost —
 * and it works the same in the app and the standalone coaching prototype.
 *
 * Preferences (on/off, chosen voice, rate) persist in localStorage so a user's
 * voice setup follows them across every coach and every session.
 */

const ENABLED_KEY = 'mh_ai_voice_on';
const URI_KEY = 'mh_ai_voice_uri';
const RATE_KEY = 'mh_ai_voice_rate';

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
const SpeechRec = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

// Strip markdown bold and emoji/symbols so speech sounds natural.
function speakable(text) {
  return (text || '')
    .replace(/\*\*/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readBool(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch { return fallback; }
}

export function useVoice() {
  const supported = !!synth;
  const sttSupported = !!SpeechRec;

  const [voices, setVoices] = useState([]);
  const [enabled, setEnabled] = useState(() => readBool(ENABLED_KEY, false));
  const [voiceURI, setVoiceURIState] = useState(() => {
    try { return localStorage.getItem(URI_KEY) || ''; } catch { return ''; }
  });
  const [rate, setRateState] = useState(() => {
    try { return parseFloat(localStorage.getItem(RATE_KEY)) || 1; } catch { return 1; }
  });
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);

  // Voices can load asynchronously; refresh on the voiceschanged event.
  useEffect(() => {
    if (!synth) return undefined;
    const load = () => {
      const all = synth.getVoices() || [];
      const en = all.filter((v) => /^en([-_]|$)/i.test(v.lang));
      setVoices(en.length ? en : all);
    };
    load();
    if (synth.addEventListener) synth.addEventListener('voiceschanged', load);
    else synth.onvoiceschanged = load;
    return () => {
      if (synth.removeEventListener) synth.removeEventListener('voiceschanged', load);
    };
  }, []);

  const persist = (key, value) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };

  const setVoiceURI = useCallback((uri) => { setVoiceURIState(uri); persist(URI_KEY, uri); }, []);
  const setRate = useCallback((r) => { setRateState(r); persist(RATE_KEY, String(r)); }, []);

  const stop = useCallback(() => {
    if (synth) synth.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback((text) => {
    if (!synth) return;
    const body = speakable(text);
    if (!body) return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(body);
    const chosen = (synth.getVoices() || []).find((v) => v.voiceURI === voiceURI);
    if (chosen) { utter.voice = chosen; utter.lang = chosen.lang; }
    utter.rate = rate;
    utter.onstart = () => setSpeaking(true);
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    synth.speak(utter);
  }, [voiceURI, rate]);

  const toggleEnabled = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      persist(ENABLED_KEY, next ? '1' : '0');
      if (!next && synth) synth.cancel();
      return next;
    });
  }, []);

  // Speak only when the user has voice mode on (used for live replies).
  const speakIfEnabled = useCallback((text) => { if (enabled) speak(text); }, [enabled, speak]);

  const startListening = useCallback((onFinal) => {
    if (!SpeechRec) return;
    try {
      const rec = new SpeechRec();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        const transcript = e.results?.[0]?.[0]?.transcript || '';
        if (transcript) onFinal(transcript);
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      recRef.current = rec;
      setListening(true);
      rec.start();
    } catch { setListening(false); }
  }, []);

  const stopListening = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
    setListening(false);
  }, []);

  // Silence speech and dictation when the component using this unmounts.
  useEffect(() => () => {
    if (synth) synth.cancel();
    try { recRef.current?.abort?.(); } catch { /* ignore */ }
  }, []);

  return {
    supported,
    sttSupported,
    voices,
    enabled,
    toggleEnabled,
    voiceURI,
    setVoiceURI,
    rate,
    setRate,
    speaking,
    stop,
    speak,
    speakIfEnabled,
    listening,
    startListening,
    stopListening,
  };
}
