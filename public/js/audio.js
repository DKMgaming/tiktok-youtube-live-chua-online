/**
 * TempleAudioEngine
 * - Nhạc nền: Phát trực tiếp file /assets/backgroud.mp3 lặp vô tận êm dịu,
 *   tự động hạ nhỏ âm lượng (ducking) khi có giọng đọc lời khấn để không bị đè tiếng hay rè/xước.
 * - Pháp khí: Tổng hợp tiếng Mõ gỗ, Đại Hồng Chung, Ống xăm nhẹ nhàng, không vượt ngưỡng 0dBFS.
 * - Giọng đọc: Hàng đợi ZeroTTS phát tuần tự mượt mà.
 */
class TempleAudioEngine {
  constructor() {
    this.ctx = null;
    this.unlocked = false;
    this.sfxEnabled = true;
    this.bgMusicEnabled = true;
    this.ttsEnabled = true;
    this.ttsVoice = 'maichi';

    // Nhạc nền "Nam Mô A Di Đà Phật.m4a" — mặc định 65%, cho phép chỉnh trực tiếp 0% - 100%
    const savedMusicVol = parseFloat(localStorage.getItem('temple_music_vol'));
    const savedTtsVol = parseFloat(localStorage.getItem('temple_tts_vol'));
    this.bgBaseVolume = Number.isFinite(savedMusicVol) ? Math.max(0, Math.min(1, savedMusicVol)) : 0.65;
    this.ttsVolume = Number.isFinite(savedTtsVol) ? Math.max(0, Math.min(1, savedTtsVol)) : 0.95;

    this.useSynthMusicFallback = false;
    this.synthBgTimer = null;
    this.isReplayingBg = false;
    this.manualStopped = false;
    this.bgErrorCount = 0;
    this.bgWatchdogTimer = null;

    this.bgAudio = new Audio('/assets/backgroud.mp3');
    this.bgAudio.loop = true;
    this.bgAudio.preload = 'auto';
    this.bgAudio.volume = this.bgBaseVolume;

    this.setupBgAudioListeners();

    this.ttsQueue = [];
    this.ttsPlaying = false;
    this.currentAudio = null;
    this.onTtsStateChange = null;
  }

  setupBgAudioListeners() {
    if (!this.bgAudio) return;

    // 1. Khi hết file nhạc: Tự động tua về đầu và replay ngay lập tức
    this.bgAudio.addEventListener('ended', () => {
      console.log('[Audio] Nhạc nền kết thúc (ended), tự động replay...');
      this.replayBgMusic('ended');
    });

    // 2. Dự phòng khi trình duyệt gặp lỗi khựng ở cuối bài (timeupdate near end)
    this.bgAudio.addEventListener('timeupdate', () => {
      if (!this.bgMusicEnabled || this.manualStopped || this.useSynthMusicFallback) return;
      if (this.bgAudio.duration > 0 && this.bgAudio.currentTime >= this.bgAudio.duration - 0.3) {
        this.replayBgMusic('timeupdate_end');
      }
    });

    // 3. Dự phòng khi trình duyệt tự động pause ở cuối bài thay vì tự lặp
    this.bgAudio.addEventListener('pause', () => {
      if (!this.bgMusicEnabled || this.manualStopped || this.useSynthMusicFallback) return;
      if (this.unlocked && (this.bgAudio.ended || (this.bgAudio.duration > 0 && this.bgAudio.currentTime >= this.bgAudio.duration - 0.5))) {
        this.replayBgMusic('pause_at_end');
      }
    });

    // 4. Khi đang phát lại thành công
    this.bgAudio.addEventListener('playing', () => {
      this.isReplayingBg = false;
      this.bgErrorCount = 0;
    });

    // 5. Xử lý lỗi nạp stream / đứt kết nối mạng giữa chừng
    this.bgAudio.addEventListener('error', (e) => {
      console.warn('[Audio] Nhạc nền gặp sự cố nạp file:', e);
      this.handleBgAudioError();
    });
  }

  replayBgMusic(trigger = 'manual') {
    if (!this.bgMusicEnabled || this.manualStopped || this.useSynthMusicFallback) return;
    if (this.isReplayingBg) return;
    this.isReplayingBg = true;

    try {
      this.bgAudio.currentTime = 0;
      this.bgAudio.volume = this.ttsPlaying ? this.getDuckedVolume() : this.bgBaseVolume;
      const playPromise = this.bgAudio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
          console.warn(`[Audio] Replay failed (${trigger}):`, err);
          // Nếu buffer bị ngắt hoặc stream bị lỗi, thử nạp lại file
          try {
            this.bgAudio.load();
            this.bgAudio.currentTime = 0;
            this.bgAudio.volume = this.ttsPlaying ? this.getDuckedVolume() : this.bgBaseVolume;
            this.bgAudio.play().catch(() => {});
          } catch (_) {}
        });
      }
    } catch (err) {
      console.warn('[Audio] Exception trong replayBgMusic:', err);
    } finally {
      setTimeout(() => {
        this.isReplayingBg = false;
      }, 500);
    }
  }

  handleBgAudioError() {
    this.bgErrorCount = (this.bgErrorCount || 0) + 1;
    if (this.bgErrorCount <= 3) {
      console.warn(`[Audio] Thử nạp lại nhạc nền lần ${this.bgErrorCount}/3 sau sự cố...`);
      setTimeout(() => {
        if (!this.bgMusicEnabled || this.manualStopped) return;
        try {
          this.bgAudio.load();
          this.bgAudio.currentTime = 0;
          this.startZenAmbience();
        } catch (_) {}
      }, 1500);
    } else {
      console.warn('[Audio] Nhạc nền MP3 không thể phục hồi, chuyển sang chuông thiền ngũ cung dự phòng.');
      this.useSynthMusicFallback = true;
      this.startDefaultZenSynthLoop();
    }
  }

  startWatchdog() {
    if (this.bgWatchdogTimer) return;
    this.bgWatchdogTimer = setInterval(() => {
      if (!this.unlocked || !this.bgMusicEnabled || this.manualStopped || this.useSynthMusicFallback) {
        return;
      }
      if (!this.bgAudio) return;

      // Kiểm tra nếu nhạc nền dừng khi bài đã hết hoặc bị pause bất thường
      const isAtEnd = this.bgAudio.ended || (this.bgAudio.duration > 0 && this.bgAudio.currentTime >= this.bgAudio.duration - 0.4);
      if (isAtEnd) {
        this.replayBgMusic('watchdog_end');
      } else if (this.bgAudio.paused) {
        this.startZenAmbience();
      }
    }, 2000);
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    this.unlocked = true;
    this.startWatchdog();
    if (this.bgMusicEnabled) {
      this.startZenAmbience();
    }
    return this.ctx;
  }

  // --------------------------------------------------------------------------
  // 1. NHẠC NỀN "NAM MÔ A DI ĐÀ PHẬT.M4A" (CÓ AUTO-DUCKING KHI ĐỌC LỜI KHẤN)
  // --------------------------------------------------------------------------
  getDuckedVolume() {
    return Math.max(0.08, +(this.bgBaseVolume * 0.35).toFixed(2));
  }

  setMusicVolume(vol) {
    const v = Math.max(0, Math.min(1, Number(vol)));
    if (!Number.isFinite(v)) return;
    this.bgBaseVolume = v;
    try {
      localStorage.setItem('temple_music_vol', String(v));
    } catch (_) {}
    if (this.bgAudio && !this.useSynthMusicFallback) {
      this.bgAudio.volume = this.ttsPlaying ? this.getDuckedVolume() : this.bgBaseVolume;
      if (v > 0 && this.unlocked && this.bgMusicEnabled && !this.manualStopped && this.bgAudio.paused) {
        this.startZenAmbience();
      }
    }
  }

  setTtsVolume(vol) {
    const v = Math.max(0, Math.min(1, Number(vol)));
    if (!Number.isFinite(v)) return;
    this.ttsVolume = v;
    try {
      localStorage.setItem('temple_tts_vol', String(v));
    } catch (_) {}
    if (this.currentAudio) {
      this.currentAudio.volume = this.ttsVolume;
    }
  }

  startZenAmbience() {
    this.manualStopped = false;
    if (!this.bgMusicEnabled) return;
    if (this.useSynthMusicFallback) {
      this.startDefaultZenSynthLoop();
      return;
    }
    try {
      this.bgAudio.volume = this.ttsPlaying ? this.getDuckedVolume() : this.bgBaseVolume;
      const isAtEnd = this.bgAudio.ended || (this.bgAudio.duration > 0 && this.bgAudio.currentTime >= this.bgAudio.duration - 0.5);
      if (isAtEnd) {
        this.bgAudio.currentTime = 0;
      }
      if (this.bgAudio.paused || isAtEnd) {
        const p = this.bgAudio.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            console.warn('[Audio] startZenAmbience play() error:', err);
            if (this.bgAudio.error) {
              this.handleBgAudioError();
            }
          });
        }
      }
    } catch (_) {
      this.handleBgAudioError();
    }
  }

  startDefaultZenSynthLoop() {
    if (!this.bgMusicEnabled || this.synthBgTimer) return;
    const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
    let step = 0;
    const playZenNote = () => {
      if (!this.bgMusicEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        const freq = PENTATONIC[step % PENTATONIC.length];
        step++;
        const vol = (this.ttsPlaying ? this.getDuckedVolume() : this.bgBaseVolume) * 0.18;
        if (vol <= 0.002) return;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(vol, now + 0.6);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 4.2);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
        };
        osc.start(now);
        osc.stop(now + 4.25);
      } catch (_) {}
    };
    playZenNote();
    this.synthBgTimer = setInterval(playZenNote, 3600);
  }

  stopZenAmbience() {
    this.manualStopped = true;
    try {
      this.bgAudio.pause();
    } catch (_) {}
    if (this.synthBgTimer) {
      clearInterval(this.synthBgTimer);
      this.synthBgTimer = null;
    }
  }

  setBgDucking(ducked) {
    if (!this.bgMusicEnabled) return;
    try {
      if (!this.useSynthMusicFallback && this.bgAudio) {
        this.bgAudio.volume = ducked ? this.getDuckedVolume() : this.bgBaseVolume;
        if (!ducked && this.unlocked && !this.manualStopped && this.bgAudio.paused) {
          this.startZenAmbience();
        }
      }
    } catch (_) {}
  }

  // --------------------------------------------------------------------------
  // 2. TIẾNG MÕ GỖ TỤNG KINH (WOODEN FISH PERCUSSION SYNTH)
  // --------------------------------------------------------------------------
  playWoodenFish(pitchMultiplier = 1.0) {
    if (!this.sfxEnabled) return;
    try {
      const ctx = this.ensureContext();
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      const baseFreq = 620 * pitchMultiplier * (0.98 + Math.random() * 0.04);
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(baseFreq * 1.4, now);
      osc1.frequency.exponentialRampToValueAtTime(baseFreq, now + 0.018);
      osc1.frequency.exponentialRampToValueAtTime(baseFreq * 0.82, now + 0.14);

      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(baseFreq * 1.15, now);
      filter.Q.setValueAtTime(4.0, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.28, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      osc1.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc1.onended = () => {
        osc1.disconnect();
        filter.disconnect();
        gain.disconnect();
      };

      osc1.start(now);
      osc1.stop(now + 0.16);
    } catch (_) {}
  }

  // --------------------------------------------------------------------------
  // 3. TIẾNG ĐẠI HỒNG CHUNG (TEMPLE BRONZE BELL)
  // --------------------------------------------------------------------------
  playTempleBell(intensity = 1.0) {
    if (!this.sfxEnabled) return;
    try {
      const ctx = this.ensureContext();
      const now = ctx.currentTime;

      const base = 174;
      const partials = [
        { ratio: 0.5, amp: 0.22, decay: 4.2 },
        { ratio: 1.0, amp: 0.35, decay: 3.6 },
        { ratio: 1.506, amp: 0.16, decay: 2.4 },
        { ratio: 2.0, amp: 0.18, decay: 1.9 }
      ];

      const master = ctx.createGain();
      master.gain.setValueAtTime(0.28 * Math.min(1.0, intensity), now);
      master.connect(ctx.destination);

      partials.forEach((p, idx) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(base * p.ratio, now);

        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(p.amp, now + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);

        osc.connect(g);
        g.connect(master);
        osc.onended = () => {
          osc.disconnect();
          g.disconnect();
          if (idx === 0) master.disconnect();
        };
        osc.start(now);
        osc.stop(now + p.decay + 0.05);
      });
    } catch (_) {}
  }

  // --------------------------------------------------------------------------
  // 4. TIẾNG LẮC ỐNG XĂM TRE (FORTUNE STICK SHAKER)
  // --------------------------------------------------------------------------
  playFortuneShake() {
    if (!this.sfxEnabled) return;
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        this.playWoodenFish(1.32 + (i % 2) * 0.16);
      }, i * 120);
    }
  }

  // --------------------------------------------------------------------------
  // 5. TIẾNG CHUÔNG NGỌC DÂNG LỄ / THẮP HƯƠNG (SINGING CHIME)
  // --------------------------------------------------------------------------
  playIncenseChime() {
    if (!this.sfxEnabled) return;
    try {
      const ctx = this.ensureContext();
      const now = ctx.currentTime;
      const notes = [528, 660];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.1);

        gain.gain.setValueAtTime(0.0001, now + idx * 0.1);
        gain.gain.linearRampToValueAtTime(0.10, now + idx * 0.1 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.1 + 1.1);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
        };
        osc.start(now + idx * 0.1);
        osc.stop(now + idx * 0.1 + 1.15);
      });
    } catch (_) {}
  }

  // --------------------------------------------------------------------------
  // 6. ZEROTTS VOICE QUEUE & PREFETCHER
  // --------------------------------------------------------------------------
  enqueueTts(text, options = {}) {
    const onStart = typeof options.onStart === 'function' ? options.onStart : null;
    const onEnd = typeof options.onEnd === 'function' ? options.onEnd : null;

    if (!this.ttsEnabled) {
      if (onStart) onStart();
      if (onEnd) setTimeout(onEnd, 5500);
      return;
    }
    const clean = String(text || '').trim();
    if (!clean) {
      if (onStart) onStart();
      if (onEnd) setTimeout(onEnd, 5500);
      return;
    }

    if (this.ttsQueue.length >= 6) {
      const dropped = this.ttsQueue.shift();
      if (dropped?.onStart) dropped.onStart();
      if (dropped?.onEnd) dropped.onEnd();
    }

    const item = {
      id: `tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text: clean,
      voice: (options.voice || this.ttsVoice || 'maichi').toLowerCase(),
      url: options.url || null,
      onStart,
      onEnd,
      fetchPromise: null
    };

    if (!item.url) {
      item.fetchPromise = this.fetchZeroTtsAudio(item.text, item.voice);
    }

    this.ttsQueue.push(item);
    this.processTtsQueue();
  }

  async fetchZeroTtsAudio(text, voice = 'maichi') {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 16000);
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await res.json();
      if (data && data.ok && data.url) {
        return data;
      }
      return { ok: false, error: data?.error || 'ZeroTTS unavailable' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  speakBrowserFallback(text, onStart, onEnd) {
    if (!('speechSynthesis' in window)) {
      if (onStart) onStart();
      if (onEnd) setTimeout(onEnd, 3500);
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'vi-VN';
      utter.rate = 0.95;
      utter.pitch = 1.0;
      utter.volume = this.ttsVolume;

      const voices = window.speechSynthesis.getVoices();
      const viVoice = voices.find(v => v.lang === 'vi-VN' || v.lang.startsWith('vi'))
        || voices.find(v => v.name.includes('Vietnamese') || v.name.includes('HoaiMy') || v.name.includes('NamMinh'));
      if (viVoice) utter.voice = viVoice;

      let started = false;
      utter.onstart = () => {
        started = true;
        this.setBgDucking(true);
        if (this.onTtsStateChange) {
          this.onTtsStateChange({ speaking: true, synthesizing: false, text });
        }
        if (onStart) onStart();
      };
      utter.onend = () => {
        this.setBgDucking(false);
        if (this.onTtsStateChange) {
          this.onTtsStateChange({ speaking: false, synthesizing: false, text: '' });
        }
        if (onEnd) onEnd();
      };
      utter.onerror = () => {
        this.setBgDucking(false);
        if (!started && onStart) onStart();
        if (onEnd) onEnd();
      };

      window.speechSynthesis.speak(utter);
    } catch (_) {
      if (onStart) onStart();
      if (onEnd) setTimeout(onEnd, 3500);
    }
  }

  async processTtsQueue() {
    if (this.ttsPlaying || this.ttsQueue.length === 0) return;
    this.ttsPlaying = true;
    const item = this.ttsQueue.shift();

    try {
      let audioUrl = item.url;
      if (!audioUrl && item.fetchPromise) {
        const res = await item.fetchPromise;
        if (res && res.ok && res.url) {
          audioUrl = res.url;
        }
      }

      if (audioUrl) {
        this.setBgDucking(true);
        if (this.onTtsStateChange) {
          this.onTtsStateChange({ speaking: true, synthesizing: false, text: item.text });
        }
        if (item.onStart) item.onStart();
        await this.playWavUrl(audioUrl);
        if (item.onEnd) item.onEnd();
      } else {
        // Fallback tự động: nếu ZeroTTS timeout hoặc bận CPU, chuyển sang giọng đọc tiếng Việt của trình duyệt
        await new Promise((resolve) => {
          this.speakBrowserFallback(item.text, item.onStart, () => {
            if (item.onEnd) item.onEnd();
            resolve();
          });
        });
      }
    } catch (err) {
      console.warn('[TTS Playback Warning]', err);
      if (item.onStart) item.onStart();
      if (item.onEnd) item.onEnd();
    } finally {
      this.ttsPlaying = false;
      if (this.ttsQueue.length === 0) {
        this.setBgDucking(false);
        if (this.onTtsStateChange) {
          this.onTtsStateChange({ speaking: false, synthesizing: false, text: '' });
        }
      } else {
        setTimeout(() => this.processTtsQueue(), 250);
      }
    }
  }

  playWavUrl(url) {
    return new Promise((resolve) => {
      try {
        const audio = new Audio(url);
        this.currentAudio = audio;
        audio.volume = this.ttsVolume;
        audio.onended = () => {
          this.currentAudio = null;
          resolve();
        };
        audio.onerror = () => {
          this.currentAudio = null;
          resolve();
        };
        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {
            this.currentAudio = null;
            resolve();
          });
        }
      } catch (_) {
        resolve();
      }
    });
  }
}

window.TempleAudioEngine = TempleAudioEngine;
