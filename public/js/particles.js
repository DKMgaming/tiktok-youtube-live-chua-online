/**
 * Ultra-Low-CPU 2.5D Sacred Temple Canvas Particle Engine
 * Tối ưu hóa tối đa cho OBS / TikTok Live treo máy 24/7:
 * - Giới hạn đúng 30 FPS (tiết kiệm 50–75% CPU/GPU so với 60/120Hz)
 * - Tự động tạm dừng khi tab ẩn (document.hidden)
 * - Pre-render toàn bộ Khói hương, Hạt vàng, Cánh hoa sen ra Offscreen Canvas 1 lần duy nhất
 *   (KHÔNG gọi createRadialGradient, bezierCurveTo hay shadowBlur trong vòng lặp frame!)
 */
class TempleParticleEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.width = 1080;
    this.height = 1920;
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    this.smokeParticles = [];
    this.lotusPetals = [];
    this.goldSparks = [];
    this.soundWaves = [];
    this.floatingTexts = [];
    this.burstParticles = [];

    this.incenseTips = [];
    this.smokeDensity = 1.0;
    this.time = 0;
    this.lastFrameTime = 0;
    this.frameInterval = 1000 / 30; // Cố định 30 FPS siêu nhẹ CPU

    this.buildOffscreenSprites();
    this.initAmbientParticles();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  buildOffscreenSprites() {
    // 1. Pre-render Smoke Puff Sprite (64x64)
    this.smokeSprite = document.createElement('canvas');
    this.smokeSprite.width = 64;
    this.smokeSprite.height = 64;
    const sctx = this.smokeSprite.getContext('2d');
    const sgrad = sctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    sgrad.addColorStop(0, 'rgba(255, 246, 218, 0.85)');
    sgrad.addColorStop(0.5, 'rgba(238, 222, 185, 0.4)');
    sgrad.addColorStop(1, 'rgba(220, 200, 160, 0)');
    sctx.fillStyle = sgrad;
    sctx.beginPath();
    sctx.arc(32, 32, 30, 0, Math.PI * 2);
    sctx.fill();

    // 2. Pre-render Gold Spark Sprite (16x16)
    this.sparkSprite = document.createElement('canvas');
    this.sparkSprite.width = 16;
    this.sparkSprite.height = 16;
    const gctx = this.sparkSprite.getContext('2d');
    const ggrad = gctx.createRadialGradient(8, 8, 1, 8, 8, 7);
    ggrad.addColorStop(0, 'rgba(255, 245, 190, 1)');
    ggrad.addColorStop(0.5, 'rgba(255, 210, 90, 0.6)');
    ggrad.addColorStop(1, 'rgba(255, 190, 50, 0)');
    gctx.fillStyle = ggrad;
    gctx.beginPath();
    gctx.arc(8, 8, 7, 0, Math.PI * 2);
    gctx.fill();

    // 3. Pre-render Pink & Gold Lotus Petal Sprites (28x28)
    this.pinkPetalSprite = this.createPetalSprite('rgba(248, 165, 194, 0.82)');
    this.goldPetalSprite = this.createPetalSprite('rgba(255, 218, 110, 0.82)');
  }

  createPetalSprite(fillStyle) {
    const c = document.createElement('canvas');
    c.width = 28;
    c.height = 28;
    const pctx = c.getContext('2d');
    const sz = 11;
    pctx.translate(14, 14);
    pctx.beginPath();
    pctx.moveTo(0, -sz);
    pctx.bezierCurveTo(sz * 0.85, -sz * 0.4, sz * 0.75, sz * 0.75, 0, sz);
    pctx.bezierCurveTo(-sz * 0.75, sz * 0.75, -sz * 0.85, -sz * 0.4, 0, -sz);
    pctx.fillStyle = fillStyle;
    pctx.fill();
    return c;
  }

  initAmbientParticles() {
    for (let i = 0; i < 20; i++) {
      this.goldSparks.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        size: 8 + Math.random() * 8,
        vy: -(0.6 + Math.random() * 1.1),
        vx: (Math.random() - 0.5) * 0.5,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.35 + Math.random() * 0.55
      });
    }

    for (let i = 0; i < 9; i++) {
      this.lotusPetals.push(this.createLotusPetal(true));
    }
  }

  createLotusPetal(randomY = false) {
    return {
      x: Math.random() * this.width,
      y: randomY ? Math.random() * this.height : -30 - Math.random() * 100,
      scale: 0.7 + Math.random() * 0.55,
      vy: 1.2 + Math.random() * 1.5,
      vx: (Math.random() - 0.5) * 0.9,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.035,
      swayPhase: Math.random() * Math.PI * 2,
      gold: Math.random() > 0.6
    };
  }

  setIncenseTips(tips) {
    this.incenseTips = Array.isArray(tips) ? tips : [];
  }

  spawnSmokeFromTips() {
    if (!this.incenseTips.length || this.smokeParticles.length >= 22) return;
    if (Math.random() > 0.45 * this.smokeDensity) return;

    const tip = this.incenseTips[Math.floor(Math.random() * this.incenseTips.length)];
    this.smokeParticles.push({
      x: tip.x + (Math.random() - 0.5) * 6,
      y: tip.y,
      vx: (Math.random() - 0.5) * 0.25,
      vy: -(2.4 + Math.random() * 1.0),
      radius: 8 + Math.random() * 5,
      maxRadius: 28 + Math.random() * 16,
      alpha: 0.24 + Math.random() * 0.1,
      age: 0,
      maxAge: 68 + Math.random() * 25,
      seed: Math.random() * 50
    });
  }

  spawnIncenseBurst(x = 540, y = 890) {
    for (let i = 0; i < 18; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
      const speed = 2.5 + Math.random() * 5.0;
      this.burstParticles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: 2.5 + Math.random() * 3.0,
        alpha: 1,
        decay: 0.035 + Math.random() * 0.02,
        color: i % 2 === 0 ? '#ffdf85' : '#ff9e44'
      });
    }
  }

  spawnBellWave(x = 540, y = 510, count = 2) {
    for (let i = 0; i < Math.min(count, 2); i++) {
      this.soundWaves.push({
        x,
        y,
        radius: 34 + i * 24,
        maxRadius: 420 + i * 50,
        alpha: 0.72 - i * 0.16,
        lineWidth: 3 - i * 0.6
      });
    }
  }

  spawnFloatingMerit(text = '+1 Công Đức', x = 540, y = 940, color = '#ffe082') {
    if (this.floatingTexts.length > 8) this.floatingTexts.shift();
    this.floatingTexts.push({
      text,
      x: x + (Math.random() - 0.5) * 36,
      y,
      vy: -3.2,
      alpha: 1.0,
      color
    });
  }

  spawnGrandCeremonyRain() {
    for (let i = 0; i < 16; i++) {
      this.lotusPetals.push(this.createLotusPetal(false));
    }
    for (let i = 0; i < 36; i++) {
      const angle = (Math.PI * 2 * i) / 36;
      const speed = 3.5 + Math.random() * 7.5;
      this.burstParticles.push({
        x: 540,
        y: 510,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: 3 + Math.random() * 3.5,
        alpha: 1,
        decay: 0.022 + Math.random() * 0.015,
        color: i % 3 === 0 ? '#fff3b0' : i % 3 === 1 ? '#ffb703' : '#ff7aa2'
      });
    }
  }

  animate(timestamp) {
    requestAnimationFrame(this.animate);

    if (document.hidden) return;
    if (timestamp - this.lastFrameTime < this.frameInterval) return;
    this.lastFrameTime = timestamp;

    this.time += 0.035;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // 1. Hạt bụi vàng (dùng drawImage từ sparkSprite đã pre-render)
    for (let i = 0; i < this.goldSparks.length; i++) {
      const sp = this.goldSparks[i];
      sp.y += sp.vy;
      sp.x += sp.vx + Math.sin(this.time + sp.phase) * 0.4;
      if (sp.y < -20) {
        sp.y = this.height + 15;
        sp.x = Math.random() * this.width;
      }
      ctx.globalAlpha = sp.alpha * (0.55 + 0.45 * Math.sin(this.time * 2.0 + sp.phase));
      ctx.drawImage(this.sparkSprite, sp.x - sp.size * 0.5, sp.y - sp.size * 0.5, sp.size, sp.size);
    }

    // 2. Khói tâm hương (dùng drawImage từ smokeSprite đã pre-render)
    this.spawnSmokeFromTips();
    for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
      const p = this.smokeParticles[i];
      p.age += 1;
      if (p.age >= p.maxAge || p.y < 495) {
        this.smokeParticles.splice(i, 1);
        continue;
      }
      const progress = p.age / p.maxAge;
      const curl = Math.sin(this.time * 1.5 + p.seed + p.y * 0.014) * 0.55;
      p.x += p.vx + curl * (0.3 + progress * 0.5);
      p.y += p.vy;

      const r = p.radius + (p.maxRadius - p.radius) * progress;
      const fade = Math.sin(progress * Math.PI) * p.alpha * (1 - progress * 0.6);
      ctx.globalAlpha = Math.max(0, fade);
      ctx.drawImage(this.smokeSprite, p.x - r, p.y - r, r * 2, r * 2);
    }

    // 3. Cánh hoa sen rơi (dùng drawImage từ petalSprite đã pre-render)
    ctx.globalAlpha = 1;
    for (let i = this.lotusPetals.length - 1; i >= 0; i--) {
      const petal = this.lotusPetals[i];
      petal.y += petal.vy;
      petal.x += petal.vx + Math.sin(this.time + petal.swayPhase) * 0.7;
      petal.rot += petal.vrot;

      if (petal.y > this.height + 35) {
        if (this.lotusPetals.length > 9) {
          this.lotusPetals.splice(i, 1);
          continue;
        } else {
          Object.assign(petal, this.createLotusPetal(false));
        }
      }

      ctx.save();
      ctx.translate(petal.x, petal.y);
      ctx.rotate(petal.rot);
      const sz = 28 * petal.scale;
      ctx.drawImage(
        petal.gold ? this.goldPetalSprite : this.pinkPetalSprite,
        -sz * 0.5,
        -sz * 0.5,
        sz,
        sz
      );
      ctx.restore();
    }

    // 4. Sóng âm Đại Hồng Chung
    for (let i = this.soundWaves.length - 1; i >= 0; i--) {
      const w = this.soundWaves[i];
      w.radius += 10.5;
      w.alpha *= 0.94;
      if (w.radius >= w.maxRadius || w.alpha < 0.03) {
        this.soundWaves.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = w.alpha;
      ctx.strokeStyle = '#ffd666';
      ctx.lineWidth = w.lineWidth;
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 5. Hạt pháo hoa sen
    for (let i = this.burstParticles.length - 1; i >= 0; i--) {
      const b = this.burstParticles[i];
      b.x += b.vx;
      b.y += b.vy;
      b.vy += 0.08;
      b.alpha -= b.decay;
      if (b.alpha <= 0) {
        this.burstParticles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.max(0, b.alpha);
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 6. Chữ +Công Đức bay lên (dùng strokeText thay vì shadowBlur tốn CPU)
    if (this.floatingTexts.length > 0) {
      ctx.font = '800 27px "Be Vietnam Pro", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(15, 4, 2, 0.9)';
      for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
        const ft = this.floatingTexts[i];
        ft.y += ft.vy;
        ft.alpha -= 0.032;
        if (ft.alpha <= 0) {
          this.floatingTexts.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = Math.max(0, ft.alpha);
        ctx.strokeText(ft.text, ft.x, ft.y);
        ctx.fillStyle = ft.color;
        ctx.fillText(ft.text, ft.x, ft.y);
      }
    }

    ctx.globalAlpha = 1;
  }
}

window.TempleParticleEngine = TempleParticleEngine;
