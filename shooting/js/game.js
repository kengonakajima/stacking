/**
 * game.js
 * ------------------------------------------------------------
 * 自然な草原フィールド上で遊べるスプライトスタッキング・シューティングと、
 * 右側「仕組み観察パネル」（風の揺れ・レイヤー分解など）を制御します。
 */
(function (global) {
  "use strict";

  const { MODELS, projectWorldToScreen, screenToWorld, drawStackedSprite } = global.StackDemo;

  // ============================================================
  // 描画パラメータ（ゲーム画面と右プレビューで共有）
  // ============================================================
  const renderSettings = {
    sliceSpacing: 2.0,
    maxLayerRatio: 1.0,
    windStrength: 1.0,
    useShading: true,
    showShadow: true,
    pixelated: true,
    showWireframe: false,
    autoRotateCamera: false,
  };

  // ============================================================
  // アリーナ・ゲーム状態
  // ============================================================
  const ARENA_HALF = 440; // ワールド座標: -440 .. +440

  const state = {
    paused: false,
    gameOver: false,
    score: 0,
    wave: 1,
    waveSpawnRemaining: 0,
    spawnTimer: 0,
    shakeTime: 0,
    time: 0,
    windTime: 0,
    player: null,
    enemies: [],
    bullets: [],
    particles: [],
    trees: [],
    grasses: [],
    camera: {
      x: 0,
      y: 0,
      angle: 0,
      screenCenterX: 400,
      screenCenterY: 300,
    },
  };

  // 入力状態
  const keys = Object.create(null);
  const mouse = {
    screenX: 0,
    screenY: 0,
    down: false,
    moved: false,
  };

  // プレビュー（右側パネル）の状態
  const preview = {
    modelId: "player",
    angle: -0.6,
    dragging: false,
    lastDragX: 0,
    highlightLayer: null,
    buildupTimer: null,
    sliceCells: [],
  };

  // ============================================================
  // DOM 要素取得
  // ============================================================
  const gameCanvas = document.getElementById("game-canvas");
  const gameCtx = gameCanvas.getContext("2d");
  const previewCanvas = document.getElementById("preview-canvas");
  const previewCtx = previewCanvas.getContext("2d");

  const hudScore = document.getElementById("hud-score");
  const hudWave = document.getElementById("hud-wave");
  const hudHpBar = document.getElementById("hud-hp-bar");
  const hudHpText = document.getElementById("hud-hp-text");
  const hudCam = document.getElementById("hud-cam");

  const pausePill = document.getElementById("pause-pill");
  const btnPillResume = document.getElementById("btn-pill-resume");
  const overlayBanner = document.getElementById("overlay-banner");
  const overlayTitle = document.getElementById("overlay-title");
  const overlayDesc = document.getElementById("overlay-desc");
  const btnPause = document.getElementById("btn-pause");
  const btnRestart = document.getElementById("btn-restart");
  const btnOverlayRestart = document.getElementById("btn-overlay-restart");

  const modelTabs = document.getElementById("model-tabs");
  const previewCaption = document.getElementById("preview-caption");
  const hoverLayerInfo = document.getElementById("hover-layer-info");
  const sliceGrid = document.getElementById("slice-grid");

  const sliderSpacing = document.getElementById("slider-spacing");
  const valSpacing = document.getElementById("val-spacing");
  const sliderLayers = document.getElementById("slider-layers");
  const valLayers = document.getElementById("val-layers");
  const sliderWind = document.getElementById("slider-wind");
  const valWind = document.getElementById("val-wind");
  const sliderCam = document.getElementById("slider-cam");
  const valCam = document.getElementById("val-cam");
  const chkAutoCam = document.getElementById("chk-auto-cam");
  const btnCamReset = document.getElementById("btn-cam-reset");
  const btnBuildup = document.getElementById("btn-buildup");
  const btnLayersFull = document.getElementById("btn-layers-full");

  const chkShading = document.getElementById("chk-shading");
  const chkShadow = document.getElementById("chk-shadow");
  const chkPixelated = document.getElementById("chk-pixelated");
  const chkWireframe = document.getElementById("chk-wireframe");

  // ============================================================
  // 自然な草原・小道テクスチャの事前生成（オフスクリーンCanvas）
  // ============================================================
  function hash2D(ix, iy) {
    const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453123;
    return n - Math.floor(n);
  }

  function valueNoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);

    const a = hash2D(ix, iy);
    const b = hash2D(ix + 1, iy);
    const c = hash2D(ix, iy + 1);
    const d = hash2D(ix + 1, iy + 1);

    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }

  function fbmNoise(x, y) {
    return (
      valueNoise(x, y) * 0.55 +
      valueNoise(x * 2.1 + 13.7, y * 2.1 + 5.2) * 0.3 +
      valueNoise(x * 4.3 + 29.1, y * 4.3 + 17.8) * 0.15
    );
  }

  /**
   * ワールド座標 (wx, wy) が土の小道にどれくらい近いか（小さいほど道の上）
   */
  function distanceToFootpath(wx, wy) {
    // ゆるやかに蛇行する2本の小道（中央の広場で交差）
    const curve1Y = Math.sin(wx * 0.0085) * 58;
    const d1 = Math.abs(wy - curve1Y);

    const curve2X = Math.sin(wy * 0.008 + 0.8) * 54;
    const d2 = Math.abs(wx - curve2X);

    // 中央の円形広場
    const centerDist = Math.hypot(wx, wy) - 52;

    return Math.min(d1, d2, Math.max(0, centerDist));
  }

  function buildTerrainCanvas() {
    const size = 220; // 低解像度ピクセルアートを拡大描画してボクセル調に統一
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(size, size);
    const data = img.data;

    const worldSpan = ARENA_HALF * 2;

    function setPx(idx, r, g, b) {
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const wx = (px / (size - 1) - 0.5) * worldSpan;
        const wy = (py / (size - 1) - 0.5) * worldSpan;

        const n = fbmNoise(wx * 0.011, wy * 0.011);
        const grain = hash2D(px, py);
        const edgeDist = Math.min(ARENA_HALF - Math.abs(wx), ARENA_HALF - Math.abs(wy));
        const pathDist = distanceToFootpath(wx, wy) + (n - 0.5) * 26;

        const idx = (py * size + px) * 4;

        // 外周の森の縁（少し濃い苔・土）
        if (edgeDist < 22 + (n - 0.5) * 14) {
          if (grain > 0.72) setPx(idx, 33, 66, 39);
          else setPx(idx, 26, 54, 33);
          continue;
        }

        // 土の小道＆中央広場
        if (pathDist < 22) {
          if (pathDist > 16) {
            // 道の縁（少し湿った土）
            setPx(idx, 122, 98, 68);
          } else if (grain > 0.93) {
            // 小石
            setPx(idx, 168, 154, 130);
          } else if (n > 0.56) {
            setPx(idx, 158, 130, 92);
          } else {
            setPx(idx, 144, 117, 81);
          }
          continue;
        }

        // 草原（濃淡のある自然な緑パッチ）
        let r, g, b;
        if (n < 0.36) {
          // 木陰っぽい深い緑
          r = 45; g = 89; b = 46;
        } else if (n < 0.52) {
          // ベース草原
          r = 56; g = 107; b = 52;
        } else if (n < 0.67) {
          // 明るい草地
          r = 69; g = 124; b = 59;
        } else {
          // 日向の若草
          r = 84; g = 140; b = 66;
        }

        // ささやかな草の質感と小さな地面の野花
        if (grain > 0.988) {
          // 地面の小さな白い花
          setPx(idx, 236, 240, 215);
        } else if (grain > 0.980 && n > 0.5) {
          // 小さな黄色い花
          setPx(idx, 244, 224, 112);
        } else if (grain < 0.14) {
          setPx(idx, r - 9, g - 12, b - 7);
        } else if (grain > 0.86) {
          setPx(idx, r + 9, g + 12, b + 6);
        } else {
          setPx(idx, r, g, b);
        }
      }
    }

    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  const terrainCanvas = buildTerrainCanvas();

  // ============================================================
  // 木と草の自然な配置（決定論的シードで毎回美しい森に）
  // ============================================================
  function buildNatureProps() {
    let seed = 4219;
    function rand() {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    }

    const trees = [];

    // 1. アリーナ内部の遮蔽物となる木々（広葉樹と針葉樹をバランスよく配置）
    const innerTreeSpots = [
      { x: -190, y: -165, kind: "tree" },
      { x: 195, y: -155, kind: "pine" },
      { x: -185, y: 165, kind: "pine" },
      { x: 185, y: 170, kind: "tree" },
      { x: -290, y: 20, kind: "tree" },
      { x: 290, y: -25, kind: "tree" },
      { x: 15, y: -265, kind: "pine" },
      { x: -25, y: 265, kind: "tree" },
    ];

    // 2. 外周を囲む森の木々（アリーナ外枠を自然に縁取る）
    const borderTreeSpots = [
      { x: -370, y: -350, kind: "pine" },
      { x: -245, y: -375, kind: "tree" },
      { x: -95, y: -380, kind: "pine" },
      { x: 135, y: -375, kind: "tree" },
      { x: 275, y: -365, kind: "pine" },
      { x: 375, y: -320, kind: "tree" },
      { x: 380, y: -180, kind: "pine" },
      { x: 382, y: 115, kind: "tree" },
      { x: 368, y: 275, kind: "pine" },
      { x: 340, y: 372, kind: "tree" },
      { x: 185, y: 378, kind: "pine" },
      { x: -140, y: 378, kind: "tree" },
      { x: -290, y: 365, kind: "pine" },
      { x: -375, y: 295, kind: "tree" },
      { x: -382, y: 155, kind: "pine" },
      { x: -380, y: -125, kind: "tree" },
      { x: -375, y: -240, kind: "pine" },
    ];

    for (const spot of [...innerTreeSpots, ...borderTreeSpots]) {
      const model = spot.kind === "pine" ? MODELS.pine : MODELS.tree;
      trees.push({
        kind: spot.kind,
        model,
        x: spot.x,
        y: spot.y,
        angle: rand() * Math.PI * 2,
        scale: model.scale * (0.9 + rand() * 0.24),
        radius: spot.kind === "pine" ? 15 : 17, // 幹の当たり判定（樹冠より小さめ）
        phaseOffset: rand() * Math.PI * 2,
        hitShake: 0,
        hitDirX: 0,
        hitDirY: 0,
      });
    }

    // 3. 草むらをたっぷり生やす（木の根元付近＋草原に点在、小道の上は避ける）
    const grasses = [];

    // 木の周りに少し集中的に生やす
    for (const tr of trees) {
      const clusterCount = 2 + Math.floor(rand() * 2);
      for (let i = 0; i < clusterCount; i++) {
        const a = rand() * Math.PI * 2;
        const d = 26 + rand() * 34;
        const gx = tr.x + Math.cos(a) * d;
        const gy = tr.y + Math.sin(a) * d;
        if (Math.abs(gx) > ARENA_HALF - 18 || Math.abs(gy) > ARENA_HALF - 18) continue;
        if (distanceToFootpath(gx, gy) < 20) continue;

        const model = rand() < 0.35 ? MODELS.grassPink : MODELS.grass;
        grasses.push({
          model,
          x: gx,
          y: gy,
          angle: rand() * Math.PI * 2,
          scale: model.scale * (0.82 + rand() * 0.35),
          phaseOffset: rand() * Math.PI * 2,
          pushX: 0,
          pushY: 0,
        });
      }
    }

    // 草原全体にランダムに草むらを追加
    for (let attempt = 0; attempt < 90 && grasses.length < 78; attempt++) {
      const gx = (rand() * 2 - 1) * (ARENA_HALF - 34);
      const gy = (rand() * 2 - 1) * (ARENA_HALF - 34);
      if (distanceToFootpath(gx, gy) < 26) continue;
      if (Math.hypot(gx, gy) < 70) continue;

      let tooClose = false;
      for (const tr of trees) {
        if (Math.hypot(gx - tr.x, gy - tr.y) < 26) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const model = rand() < 0.4 ? MODELS.grassPink : MODELS.grass;
      grasses.push({
        model,
        x: gx,
        y: gy,
        angle: rand() * Math.PI * 2,
        scale: model.scale * (0.8 + rand() * 0.4),
        phaseOffset: rand() * Math.PI * 2,
        pushX: 0,
        pushY: 0,
      });
    }

    return { trees, grasses };
  }

  // ============================================================
  // 風の揺れベクトル計算（草原を波のように吹き抜ける風）
  // ============================================================
  function computeWindSway(wx, wy, model, phaseOffset, extraWorldX, extraWorldY) {
    const strength = renderSettings.windStrength;

    // ワールド座標に応じた位相ずれ → 風の波（突風）が草原を流れていくように見える
    const wavePhase = state.windTime * 2.1 + wx * 0.011 + wy * 0.007 + phaseOffset * 0.35;
    const gust = 0.65 + 0.35 * Math.sin(state.windTime * 0.75 + wx * 0.004);

    const primary = Math.sin(wavePhase) * gust;
    const flutter = Math.sin(wavePhase * 2.3 + phaseOffset) * 0.24;

    // 風の吹き抜けるワールド方向（少し斜めに吹く）
    const swayMag = (primary + flutter) * model.swayAmount * strength;
    const worldDx = swayMag * 0.92 + (extraWorldX || 0);
    const worldDy = swayMag * 0.38 + (extraWorldY || 0);

    // カメラ回転角に合わせてスクリーン方向へ変換
    const cos = Math.cos(state.camera.angle);
    const sin = Math.sin(state.camera.angle);

    return {
      swayX: worldDx * cos - worldDy * sin,
      swayY: (worldDx * sin + worldDy * cos) * 0.45,
      swayTwist: (primary * 0.08 + flutter * 0.05) * strength,
    };
  }

  // ============================================================
  // ゲーム初期化・リセット
  // ============================================================
  function resetGame() {
    state.paused = false;
    state.gameOver = false;
    state.score = 0;
    state.wave = 1;
    state.waveSpawnRemaining = 5;
    state.spawnTimer = 0.9;
    state.shakeTime = 0;
    state.enemies = [];
    state.bullets = [];
    state.particles = [];

    state.player = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      radius: 17,
      hp: 5,
      maxHp: 5,
      fireCooldown: 0,
      invulnTimer: 0,
      flashTimer: 0,
    };

    const nature = buildNatureProps();
    state.trees = nature.trees;
    state.grasses = nature.grasses;

    state.camera.x = 0;
    state.camera.y = 0;

    hideOverlay();
    updateHud();
  }

  function showGameOverOverlay(title, desc) {
    overlayTitle.textContent = title;
    overlayDesc.textContent = desc;
    overlayBanner.classList.remove("hidden");
  }

  function hideOverlay() {
    overlayBanner.classList.add("hidden");
    pausePill.classList.add("hidden");
  }

  function togglePause() {
    if (state.gameOver) return;
    state.paused = !state.paused;
    btnPause.textContent = state.paused ? "再開 (P)" : "一時停止 (P)";
    pausePill.classList.toggle("hidden", !state.paused);
  }

  function updateHud() {
    hudScore.textContent = String(state.score);
    hudWave.textContent = String(state.wave);
    const hp = state.player ? state.player.hp : 0;
    const maxHp = state.player ? state.player.maxHp : 5;
    hudHpText.textContent = `${hp}/${maxHp}`;
    hudHpBar.style.width = `${(hp / maxHp) * 100}%`;
    hudHpBar.classList.toggle("low", hp <= 2);

    const deg = normalizeDeg(Math.round((state.camera.angle * 180) / Math.PI));
    hudCam.textContent = `${deg}°`;
    valCam.textContent = `${deg}°`;
    sliderCam.value = String(deg);
  }

  function normalizeDeg(deg) {
    return (((deg + 180) % 360) + 360) % 360 - 180;
  }

  // ============================================================
  // 敵生成・弾・パーティクル
  // ============================================================
  function spawnEnemy() {
    // 木の幹と重ならない位置を外周付近から選ぶ
    let x = 0;
    let y = 0;
    const margin = ARENA_HALF - 48;
    for (let tries = 0; tries < 12; tries++) {
      const edge = Math.floor(Math.random() * 4);
      if (edge === 0) {
        x = -margin + Math.random() * margin * 2;
        y = -margin;
      } else if (edge === 1) {
        x = -margin + Math.random() * margin * 2;
        y = margin;
      } else if (edge === 2) {
        x = -margin;
        y = -margin + Math.random() * margin * 2;
      } else {
        x = margin;
        y = -margin + Math.random() * margin * 2;
      }
      let blocked = false;
      for (const tr of state.trees) {
        if (Math.hypot(x - tr.x, y - tr.y) < tr.radius + 32) {
          blocked = true;
          break;
        }
      }
      if (!blocked) break;
    }

    const heavyChance = Math.min(0.45, 0.15 + (state.wave - 1) * 0.08);
    const isHeavy = state.wave >= 2 && Math.random() < heavyChance;

    if (isHeavy) {
      state.enemies.push({
        type: "heavy",
        model: MODELS.heavy,
        x,
        y,
        angle: Math.atan2(state.player.y - y, state.player.x - x),
        speed: 62 + state.wave * 4,
        radius: 21,
        hp: 4 + Math.floor(state.wave / 2),
        score: 250,
        fireTimer: 1.4 + Math.random() * 0.8,
        flashTimer: 0,
      });
    } else {
      state.enemies.push({
        type: "scout",
        model: MODELS.scout,
        x,
        y,
        angle: Math.random() * Math.PI * 2,
        speed: 105 + state.wave * 7,
        radius: 14,
        hp: 2,
        score: 100,
        fireTimer: 99,
        flashTimer: 0,
      });
    }
  }

  function firePlayerShot() {
    const p = state.player;
    const cos = Math.cos(p.angle);
    const sin = Math.sin(p.angle);
    const offsets = [-11, 11];
    for (const side of offsets) {
      const bx = p.x + cos * 16 - sin * side;
      const by = p.y + sin * 16 + cos * side;
      state.bullets.push({
        fromPlayer: true,
        model: MODELS.playerBullet,
        x: bx,
        y: by,
        vx: cos * 560,
        vy: sin * 560,
        angle: p.angle,
        radius: 7,
        life: 1.3,
      });
    }
    spawnBurst(p.x + cos * 20, p.y + sin * 20, "#38bdf8", 4, 90, 10);
  }

  function fireEnemyShot(enemy) {
    const cos = Math.cos(enemy.angle);
    const sin = Math.sin(enemy.angle);
    state.bullets.push({
      fromPlayer: false,
      model: MODELS.enemyBullet,
      x: enemy.x + cos * 22,
      y: enemy.y + sin * 22,
      vx: cos * 240,
      vy: sin * 240,
      angle: enemy.angle,
      radius: 7,
      life: 2.6,
    });
  }

  function spawnBurst(x, y, color, count, speed, baseZ) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (0.3 + Math.random() * 0.8) * speed;
      state.particles.push({
        x,
        y,
        z: (baseZ || 6) + Math.random() * 14,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        vz: 30 + Math.random() * 70,
        size: 3 + Math.random() * 4,
        color,
        life: 0.35 + Math.random() * 0.4,
        maxLife: 0.75,
        gravity: 220,
      });
    }
  }

  function spawnLeaves(x, y, isPine) {
    const colors = isPine ? ["#245c44", "#36805c", "#59a87a"] : ["#449443", "#6ab84d", "#9be05c"];
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 28 + Math.random() * 65;
      state.particles.push({
        x: x + (Math.random() - 0.5) * 18,
        y: y + (Math.random() - 0.5) * 18,
        z: 18 + Math.random() * 16,
        vx: Math.cos(a) * spd + renderSettings.windStrength * 22,
        vy: Math.sin(a) * spd + renderSettings.windStrength * 8,
        vz: 18 + Math.random() * 30,
        size: 3 + Math.random() * 3,
        color: colors[i % colors.length],
        life: 0.65 + Math.random() * 0.55,
        maxLife: 1.2,
        gravity: 55, // 葉っぱはひらひらゆっくり落ちる
      });
    }
  }

  // ============================================================
  // 衝突ヘルパー
  // ============================================================
  function resolveCircleTreeCollision(entity) {
    for (const tr of state.trees) {
      const dx = entity.x - tr.x;
      const dy = entity.y - tr.y;
      const minDist = entity.radius + tr.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq < minDist * minDist && distSq > 0.0001) {
        const dist = Math.sqrt(distSq);
        const push = minDist - dist;
        entity.x += (dx / dist) * push;
        entity.y += (dy / dist) * push;
      }
    }
  }

  function clampToArena(entity) {
    const limit = ARENA_HALF - entity.radius - 10;
    entity.x = Math.max(-limit, Math.min(limit, entity.x));
    entity.y = Math.max(-limit, Math.min(limit, entity.y));
  }

  // ============================================================
  // ゲーム更新ステップ
  // ============================================================
  function updateGame(dt) {
    // 風の時間はポーズ中も進め、スライダーで揺れの仕組みを観察できるようにする
    state.windTime += dt;

    // カメラ回転もポーズ中に操作可能
    const camSpeed = 1.6;
    let camChanged = false;
    if (keys["KeyQ"]) {
      state.camera.angle -= camSpeed * dt;
      camChanged = true;
    }
    if (keys["KeyE"]) {
      state.camera.angle += camSpeed * dt;
      camChanged = true;
    }
    if (renderSettings.autoRotateCamera) {
      state.camera.angle += 0.45 * dt;
      camChanged = true;
    }
    if (camChanged) {
      updateHud();
    }

    if (state.paused || state.gameOver) return;

    state.time += dt;
    const p = state.player;
    if (state.shakeTime > 0) state.shakeTime = Math.max(0, state.shakeTime - dt);
    if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - dt);
    if (p.flashTimer > 0) p.flashTimer = Math.max(0, p.flashTimer - dt);
    if (p.fireCooldown > 0) p.fireCooldown = Math.max(0, p.fireCooldown - dt);

    // 1. プレイヤー移動（カメラ回転に合わせて入力方向をワールド座標系へ変換）
    let ix = 0;
    let iy = 0;
    if (keys["KeyW"] || keys["ArrowUp"]) iy -= 1;
    if (keys["KeyS"] || keys["ArrowDown"]) iy += 1;
    if (keys["KeyA"] || keys["ArrowLeft"]) ix -= 1;
    if (keys["KeyD"] || keys["ArrowRight"]) ix += 1;

    if (ix !== 0 || iy !== 0) {
      const len = Math.hypot(ix, iy);
      ix /= len;
      iy /= len;
      const cos = Math.cos(-state.camera.angle);
      const sin = Math.sin(-state.camera.angle);
      const wx = ix * cos - iy * sin;
      const wy = ix * sin + iy * cos;
      const moveSpeed = 230;
      p.vx = wx * moveSpeed;
      p.vy = wy * moveSpeed;
    } else {
      p.vx *= 0.8;
      p.vy *= 0.8;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    resolveCircleTreeCollision(p);
    clampToArena(p);

    // カメラ追従
    state.camera.x += (p.x * 0.48 - state.camera.x) * Math.min(1, dt * 6);
    state.camera.y += (p.y * 0.48 - state.camera.y) * Math.min(1, dt * 6);

    // 2. マウス照準
    if (mouse.moved) {
      const aimWorld = screenToWorld(mouse.screenX, mouse.screenY, state.camera);
      p.angle = Math.atan2(aimWorld.y - p.y, aimWorld.x - p.x);
    } else if (Math.hypot(p.vx, p.vy) > 10) {
      p.angle = Math.atan2(p.vy, p.vx);
    }

    // 3. 射撃
    if ((mouse.down || keys["Space"]) && p.fireCooldown <= 0) {
      firePlayerShot();
      p.fireCooldown = 0.16;
    }

    // 4. ウェーブ＆敵スポーン
    if (state.waveSpawnRemaining > 0) {
      state.spawnTimer -= dt;
      if (state.spawnTimer <= 0) {
        spawnEnemy();
        state.waveSpawnRemaining--;
        state.spawnTimer = Math.max(0.45, 1.35 - state.wave * 0.08);
      }
    } else if (state.enemies.length === 0) {
      state.wave++;
      state.waveSpawnRemaining = 5 + state.wave * 2;
      state.spawnTimer = 1.0;
      if (p.hp < p.maxHp) p.hp++;
      updateHud();
    }

    // 5. 敵の更新
    for (let i = state.enemies.length - 1; i >= 0; i--) {
      const e = state.enemies[i];
      if (e.flashTimer > 0) e.flashTimer = Math.max(0, e.flashTimer - dt);

      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const dist = Math.hypot(dx, dy) || 1;

      if (e.type === "scout") {
        e.angle += 3.2 * dt;
        e.x += (dx / dist) * e.speed * dt;
        e.y += (dy / dist) * e.speed * dt;
      } else {
        const targetAngle = Math.atan2(dy, dx);
        let diff = targetAngle - e.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        e.angle += diff * Math.min(1, dt * 3.5);

        if (dist > 170) {
          e.x += Math.cos(e.angle) * e.speed * dt;
          e.y += Math.sin(e.angle) * e.speed * dt;
        }
        e.fireTimer -= dt;
        if (e.fireTimer <= 0 && dist < 440) {
          fireEnemyShot(e);
          e.fireTimer = Math.max(1.1, 2.2 - state.wave * 0.1);
        }
      }

      resolveCircleTreeCollision(e);
      clampToArena(e);

      for (let j = i - 1; j >= 0; j--) {
        const other = state.enemies[j];
        const ex = e.x - other.x;
        const ey = e.y - other.y;
        const minD = e.radius + other.radius;
        const d2 = ex * ex + ey * ey;
        if (d2 < minD * minD && d2 > 0.001) {
          const d = Math.sqrt(d2);
          const push = (minD - d) * 0.5;
          e.x += (ex / d) * push;
          e.y += (ey / d) * push;
          other.x -= (ex / d) * push;
          other.y -= (ey / d) * push;
        }
      }

      const pdx = p.x - e.x;
      const pdy = p.y - e.y;
      if (pdx * pdx + pdy * pdy < (p.radius + e.radius) ** 2) {
        damagePlayer();
      }
    }

    // 6. 木の被弾揺れ減衰＆草むらの通過押し分け（機体が草の上を通ると草がしなる！）
    for (const tr of state.trees) {
      if (tr.hitShake > 0) {
        tr.hitShake = Math.max(0, tr.hitShake - dt * 2.8);
      }
    }

    for (const gr of state.grasses) {
      let targetX = 0;
      let targetY = 0;

      // プレイヤーのスラスター風で草が外向きに倒れる
      const pdx = gr.x - p.x;
      const pdy = gr.y - p.y;
      const pDist = Math.hypot(pdx, pdy);
      if (pDist < 42 && pDist > 0.5) {
        const force = (1 - pDist / 42) * 14;
        targetX += (pdx / pDist) * force;
        targetY += (pdy / pDist) * force;
      }

      // 敵が通ったときも草が揺れる
      for (const e of state.enemies) {
        const edx = gr.x - e.x;
        const edy = gr.y - e.y;
        const eDist = Math.hypot(edx, edy);
        if (eDist < 36 && eDist > 0.5) {
          const force = (1 - eDist / 36) * 11;
          targetX += (edx / eDist) * force;
          targetY += (edy / eDist) * force;
        }
      }

      const lerp = Math.min(1, dt * 8);
      gr.pushX += (targetX - gr.pushX) * lerp;
      gr.pushY += (targetY - gr.pushY) * lerp;
    }

    // 7. 弾の更新と当たり判定
    for (let i = state.bullets.length - 1; i >= 0; i--) {
      const b = state.bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;

      let remove = b.life <= 0 || Math.abs(b.x) > ARENA_HALF || Math.abs(b.y) > ARENA_HALF;

      // 木の幹に当たると木が大きく揺れて葉っぱが舞い散る
      if (!remove) {
        for (const tr of state.trees) {
          const dx = b.x - tr.x;
          const dy = b.y - tr.y;
          if (dx * dx + dy * dy < (b.radius + tr.radius) ** 2) {
            const spd = Math.hypot(b.vx, b.vy) || 1;
            tr.hitShake = 1.0;
            tr.hitDirX = b.vx / spd;
            tr.hitDirY = b.vy / spd;
            spawnLeaves(tr.x, tr.y, tr.kind === "pine");
            remove = true;
            break;
          }
        }
      }

      // 敵またはプレイヤーとの命中判定
      if (!remove && b.fromPlayer) {
        for (let j = state.enemies.length - 1; j >= 0; j--) {
          const e = state.enemies[j];
          const dx = b.x - e.x;
          const dy = b.y - e.y;
          if (dx * dx + dy * dy < (b.radius + e.radius) ** 2) {
            e.hp--;
            e.flashTimer = 0.08;
            spawnBurst(b.x, b.y, "#fde047", 6, 130, 10);
            remove = true;

            if (e.hp <= 0) {
              state.score += e.score;
              state.shakeTime = 0.12;
              spawnBurst(e.x, e.y, e.type === "heavy" ? "#ef4444" : "#e879f9", 18, 200, 12);
              spawnBurst(e.x, e.y, "#fde047", 8, 120, 14);
              state.enemies.splice(j, 1);
              updateHud();
            }
            break;
          }
        }
      } else if (!remove && !b.fromPlayer) {
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        if (dx * dx + dy * dy < (b.radius + p.radius) ** 2) {
          remove = true;
          damagePlayer();
        }
      }

      if (remove) {
        state.bullets.splice(i, 1);
      }
    }

    // 8. 立体パーティクル・舞い落ちる葉っぱの更新
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const pt = state.particles[i];
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.z += pt.vz * dt;
      pt.vz -= (pt.gravity || 220) * dt;
      if (pt.z < 0) {
        pt.z = 0;
        pt.vz *= -0.35;
      }
      pt.vx *= 0.94;
      pt.vy *= 0.94;
      pt.life -= dt;
      if (pt.life <= 0) {
        state.particles.splice(i, 1);
      }
    }
  }

  function damagePlayer() {
    const p = state.player;
    if (p.invulnTimer > 0 || state.gameOver) return;
    p.hp--;
    p.invulnTimer = 1.0;
    p.flashTimer = 0.16;
    state.shakeTime = 0.22;
    spawnBurst(p.x, p.y, "#f43f5e", 16, 180, 10);
    updateHud();

    if (p.hp <= 0) {
      state.gameOver = true;
      pausePill.classList.add("hidden");
      showGameOverOverlay(
        "GAME OVER",
        `最終スコア: ${state.score}（WAVE ${state.wave}）— 右側のパネルで木や機体を観察したり、リスタートして再挑戦できます。`
      );
    }
  }

  // ============================================================
  // ゲーム画面の描画（自然な地面 ＋ ペインターズソート ＋ スプライトスタッキング）
  // ============================================================
  function drawNaturalGround(ctx, cam) {
    ctx.save();
    ctx.translate(cam.screenCenterX, cam.screenCenterY);
    ctx.rotate(cam.angle);
    ctx.translate(-cam.x, -cam.y);

    // 周囲の深い森ベース（フィールド外周）
    ctx.fillStyle = "#183320";
    ctx.fillRect(-ARENA_HALF - 40, -ARENA_HALF - 40, (ARENA_HALF + 40) * 2, (ARENA_HALF + 40) * 2);

    // 事前生成した自然な草原＋小道テクスチャを描画
    ctx.imageSmoothingEnabled = !renderSettings.pixelated;
    ctx.drawImage(terrainCanvas, -ARENA_HALF, -ARENA_HALF, ARENA_HALF * 2, ARENA_HALF * 2);

    // フィールド外枠（やわらかな木の柵／縁取りイメージ）
    ctx.strokeStyle = "rgba(26, 48, 28, 0.85)";
    ctx.lineWidth = 6;
    ctx.strokeRect(-ARENA_HALF, -ARENA_HALF, ARENA_HALF * 2, ARENA_HALF * 2);

    ctx.restore();
  }

  function renderGame() {
    const w = gameCanvas.width;
    const h = gameCanvas.height;
    gameCtx.clearRect(0, 0, w, h);

    const shakeX = state.shakeTime > 0 ? (Math.random() - 0.5) * 8 : 0;
    const shakeY = state.shakeTime > 0 ? (Math.random() - 0.5) * 8 : 0;

    state.camera.screenCenterX = w / 2 + shakeX;
    state.camera.screenCenterY = h / 2 + shakeY;

    // 1. 自然な地面を描画
    drawNaturalGround(gameCtx, state.camera);

    // 2. すべての立体オブジェクトをスクリーン座標に変換してリスト化
    const drawList = [];

    // 草むら（風と機体の通過でしなる）
    for (const gr of state.grasses) {
      const sp = projectWorldToScreen(gr.x, gr.y, state.camera);
      // 画面外カリング
      if (sp.x < -60 || sp.x > w + 60 || sp.y < -60 || sp.y > h + 90) continue;

      const wind = computeWindSway(gr.x, gr.y, gr.model, gr.phaseOffset, gr.pushX, gr.pushY);
      drawList.push({
        sortY: sp.y - 3, // 同位置なら草がわずかに後ろへ
        draw: () =>
          drawStackedSprite(gameCtx, gr.model, {
            x: sp.x,
            y: sp.y,
            angle: gr.angle + state.camera.angle,
            scale: gr.scale,
            sliceSpacing: renderSettings.sliceSpacing * 0.9,
            maxLayerRatio: renderSettings.maxLayerRatio,
            useShading: renderSettings.useShading,
            showShadow: renderSettings.showShadow,
            pixelated: renderSettings.pixelated,
            showWireframe: renderSettings.showWireframe,
            swayX: wind.swayX,
            swayY: wind.swayY,
            swayTwist: wind.swayTwist,
          }),
      });
    }

    // 木々（広葉樹・針葉樹：風と被弾でしなる）
    for (const tr of state.trees) {
      const sp = projectWorldToScreen(tr.x, tr.y, state.camera);
      if (sp.x < -100 || sp.x > w + 100 || sp.y < -120 || sp.y > h + 140) continue;

      const hitOsc = tr.hitShake > 0 ? Math.sin(tr.hitShake * 28) * tr.hitShake * 10 : 0;
      const wind = computeWindSway(
        tr.x,
        tr.y,
        tr.model,
        tr.phaseOffset,
        tr.hitDirX * hitOsc,
        tr.hitDirY * hitOsc
      );

      drawList.push({
        sortY: sp.y,
        draw: () =>
          drawStackedSprite(gameCtx, tr.model, {
            x: sp.x,
            y: sp.y,
            angle: tr.angle + state.camera.angle,
            scale: tr.scale,
            sliceSpacing: renderSettings.sliceSpacing,
            maxLayerRatio: renderSettings.maxLayerRatio,
            useShading: renderSettings.useShading,
            showShadow: renderSettings.showShadow,
            pixelated: renderSettings.pixelated,
            showWireframe: renderSettings.showWireframe,
            swayX: wind.swayX,
            swayY: wind.swayY,
            swayTwist: wind.swayTwist,
          }),
      });
    }

    // 敵
    for (const e of state.enemies) {
      const sp = projectWorldToScreen(e.x, e.y, state.camera);
      drawList.push({
        sortY: sp.y,
        draw: () =>
          drawStackedSprite(gameCtx, e.model, {
            x: sp.x,
            y: sp.y,
            angle: e.angle + state.camera.angle,
            sliceSpacing: renderSettings.sliceSpacing,
            maxLayerRatio: renderSettings.maxLayerRatio,
            useShading: renderSettings.useShading,
            showShadow: renderSettings.showShadow,
            pixelated: renderSettings.pixelated,
            showWireframe: renderSettings.showWireframe,
            flash: e.flashTimer > 0,
            elevation: e.type === "scout" ? 5 + Math.sin(state.windTime * 5 + e.x) * 2.5 : 0,
          }),
      });
    }

    // 自機
    if (!state.gameOver && state.player) {
      const p = state.player;
      const sp = projectWorldToScreen(p.x, p.y, state.camera);
      const blinkHide = p.invulnTimer > 0 && Math.floor(p.invulnTimer * 18) % 2 === 0;
      if (!blinkHide) {
        drawList.push({
          sortY: sp.y,
          draw: () => {
            const aimAngle = p.angle + state.camera.angle;
            gameCtx.save();
            gameCtx.strokeStyle = "rgba(241, 245, 249, 0.35)";
            gameCtx.lineWidth = 1.2;
            gameCtx.setLineDash([4, 5]);
            gameCtx.beginPath();
            gameCtx.moveTo(sp.x, sp.y - 6);
            gameCtx.lineTo(sp.x + Math.cos(aimAngle) * 110, sp.y - 6 + Math.sin(aimAngle) * 110);
            gameCtx.stroke();
            gameCtx.restore();

            drawStackedSprite(gameCtx, MODELS.player, {
              x: sp.x,
              y: sp.y,
              angle: aimAngle,
              sliceSpacing: renderSettings.sliceSpacing,
              maxLayerRatio: renderSettings.maxLayerRatio,
              useShading: renderSettings.useShading,
              showShadow: renderSettings.showShadow,
              pixelated: renderSettings.pixelated,
              showWireframe: renderSettings.showWireframe,
              flash: p.flashTimer > 0,
              elevation: 4 + Math.sin(state.windTime * 4.5) * 1.5,
            });
          },
        });
      }
    }

    // 弾
    for (const b of state.bullets) {
      const sp = projectWorldToScreen(b.x, b.y, state.camera);
      drawList.push({
        sortY: sp.y,
        draw: () =>
          drawStackedSprite(gameCtx, b.model, {
            x: sp.x,
            y: sp.y,
            angle: b.angle + state.camera.angle,
            sliceSpacing: Math.min(renderSettings.sliceSpacing, 2.5),
            maxLayerRatio: renderSettings.maxLayerRatio,
            useShading: false,
            showShadow: renderSettings.showShadow,
            pixelated: renderSettings.pixelated,
            showWireframe: false,
            elevation: 9,
          }),
      });
    }

    // パーティクル・舞い落ちる葉
    for (const pt of state.particles) {
      const sp = projectWorldToScreen(pt.x, pt.y, state.camera);
      drawList.push({
        sortY: sp.y + 1,
        draw: () => {
          const alpha = Math.max(0, pt.life / pt.maxLife);
          gameCtx.save();
          gameCtx.globalAlpha = alpha;
          gameCtx.fillStyle = pt.color;
          const lift = pt.z * (renderSettings.sliceSpacing / 2);
          gameCtx.fillRect(sp.x - pt.size / 2, sp.y - lift - pt.size / 2, pt.size, pt.size);
          gameCtx.restore();
        },
      });
    }

    // 3. ペインターズアルゴリズム: スクリーンYが小さい（奥にある）順に描画！
    drawList.sort((a, b) => a.sortY - b.sortY);
    for (const item of drawList) {
      item.draw();
    }
  }

  // ============================================================
  // 右側パネル: 単体モデルプレビュー & 2Dスプライトシート表示
  // ============================================================
  function rebuildSliceGrid() {
    const model = MODELS[preview.modelId];
    sliceGrid.innerHTML = "";
    preview.sliceCells = [];

    for (let z = 0; z < model.layerCount; z++) {
      const cell = document.createElement("div");
      cell.className = "slice-cell";
      cell.dataset.layer = String(z);

      const thumb = document.createElement("canvas");
      thumb.width = model.width;
      thumb.height = model.height;
      const tCtx = thumb.getContext("2d");
      tCtx.imageSmoothingEnabled = false;
      tCtx.drawImage(model.rawCanvases[z], 0, 0);

      const label = document.createElement("span");
      label.textContent = `Z=${z}`;

      cell.appendChild(thumb);
      cell.appendChild(label);

      cell.addEventListener("mouseenter", () => {
        preview.highlightLayer = z;
        cell.classList.add("highlighted");
        const offsetPx = (z * renderSettings.sliceSpacing).toFixed(1);
        hoverLayerInfo.textContent = `Z=${z} (上へ -${offsetPx}px)`;
      });
      cell.addEventListener("mouseleave", () => {
        preview.highlightLayer = null;
        cell.classList.remove("highlighted");
        hoverLayerInfo.textContent = "層にカーソルを合わせて確認";
      });

      sliceGrid.appendChild(cell);
      preview.sliceCells.push(cell);
    }

    updateSliceGridVisibility();
  }

  function updateSliceGridVisibility() {
    const model = MODELS[preview.modelId];
    const visibleLayers = Math.max(
      1,
      Math.min(model.layerCount, Math.ceil(model.layerCount * renderSettings.maxLayerRatio))
    );

    preview.sliceCells.forEach((cell, idx) => {
      cell.classList.toggle("hidden-layer", idx >= visibleLayers);
    });

    const swayNote = model.swayable ? ` ／ 風 ${renderSettings.windStrength.toFixed(1)}x` : "";
    previewCaption.textContent = `${model.name}：${visibleLayers}/${model.layerCount}層（間隔 ${renderSettings.sliceSpacing.toFixed(1)}px${swayNote}）`;
  }

  function renderPreview(dt) {
    if (!preview.dragging) {
      preview.angle += dt * 0.85;
    }

    const model = MODELS[preview.modelId];
    const w = previewCanvas.width;
    const h = previewCanvas.height;
    previewCtx.clearRect(0, 0, w, h);

    const totalHeight = (model.layerCount - 1) * renderSettings.sliceSpacing;
    const baseY = Math.min(h - 28, h / 2 + totalHeight * 0.45 + 16);

    previewCtx.save();
    previewCtx.strokeStyle = model.swayable
      ? "rgba(74, 222, 128, 0.24)"
      : "rgba(56, 189, 248, 0.18)";
    previewCtx.lineWidth = 1;
    previewCtx.beginPath();
    previewCtx.ellipse(w / 2, baseY + 6, 62, 24, 0, 0, Math.PI * 2);
    previewCtx.stroke();
    previewCtx.restore();

    let swayX = 0;
    let swayY = 0;
    let swayTwist = 0;
    if (model.swayable) {
      const wave = Math.sin(state.windTime * 2.2) + Math.sin(state.windTime * 4.7) * 0.22;
      swayX = wave * model.swayAmount * 1.45 * renderSettings.windStrength;
      swayY = Math.cos(state.windTime * 1.6) * model.swayAmount * 0.25 * renderSettings.windStrength;
      swayTwist = wave * 0.09 * renderSettings.windStrength;
    }

    drawStackedSprite(previewCtx, model, {
      x: w / 2,
      y: baseY,
      angle: preview.angle,
      scale: model.scale * 1.35,
      sliceSpacing: renderSettings.sliceSpacing,
      maxLayerRatio: renderSettings.maxLayerRatio,
      useShading: renderSettings.useShading,
      showShadow: renderSettings.showShadow,
      pixelated: renderSettings.pixelated,
      showWireframe: renderSettings.showWireframe,
      highlightLayer: preview.highlightLayer,
      swayX,
      swayY,
      swayTwist,
    });
  }

  // ============================================================
  // UI イベント配線
  // ============================================================
  function setSliceSpacing(value) {
    renderSettings.sliceSpacing = value;
    sliderSpacing.value = String(value);
    valSpacing.textContent = `${value.toFixed(1)} px`;

    document.querySelectorAll("[data-spacing]").forEach((btn) => {
      const v = parseFloat(btn.dataset.spacing);
      btn.classList.toggle("active", Math.abs(v - value) < 0.05);
    });
    updateSliceGridVisibility();
  }

  function setWindStrength(value) {
    renderSettings.windStrength = value;
    sliderWind.value = String(value);
    valWind.textContent = `${value.toFixed(1)}x`;

    document.querySelectorAll("[data-wind]").forEach((btn) => {
      const v = parseFloat(btn.dataset.wind);
      btn.classList.toggle("active", Math.abs(v - value) < 0.05);
    });
    updateSliceGridVisibility();
  }

  function setLayerRatio(percent) {
    renderSettings.maxLayerRatio = percent / 100;
    sliderLayers.value = String(percent);
    valLayers.textContent = `${percent}%`;
    updateSliceGridVisibility();
  }

  function startBuildupAnimation() {
    if (preview.buildupTimer) {
      clearInterval(preview.buildupTimer);
      preview.buildupTimer = null;
    }
    const model = MODELS[preview.modelId];
    let step = 1;
    setLayerRatio(Math.ceil((step / model.layerCount) * 100));

    preview.buildupTimer = setInterval(() => {
      step++;
      if (step > model.layerCount) {
        clearInterval(preview.buildupTimer);
        preview.buildupTimer = null;
        setLayerRatio(100);
        return;
      }
      setLayerRatio(Math.min(100, Math.ceil((step / model.layerCount) * 100)));
    }, 150);
  }

  // モデル切替タブ
  modelTabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-model]");
    if (!btn) return;
    preview.modelId = btn.dataset.model;
    modelTabs.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    preview.highlightLayer = null;
    rebuildSliceGrid();
  });

  // プレビューの手動ドラッグ回転
  previewCanvas.addEventListener("mousedown", (ev) => {
    preview.dragging = true;
    preview.lastDragX = ev.clientX;
  });
  window.addEventListener("mousemove", (ev) => {
    if (preview.dragging) {
      const dx = ev.clientX - preview.lastDragX;
      preview.lastDragX = ev.clientX;
      preview.angle += dx * 0.02;
    }
  });
  window.addEventListener("mouseup", () => {
    preview.dragging = false;
  });

  // スライダー・ボタン類
  sliderSpacing.addEventListener("input", () => setSliceSpacing(parseFloat(sliderSpacing.value)));
  document.querySelectorAll("[data-spacing]").forEach((btn) => {
    btn.addEventListener("click", () => setSliceSpacing(parseFloat(btn.dataset.spacing)));
  });

  sliderWind.addEventListener("input", () => setWindStrength(parseFloat(sliderWind.value)));
  document.querySelectorAll("[data-wind]").forEach((btn) => {
    btn.addEventListener("click", () => setWindStrength(parseFloat(btn.dataset.wind)));
  });

  sliderLayers.addEventListener("input", () => {
    if (preview.buildupTimer) {
      clearInterval(preview.buildupTimer);
      preview.buildupTimer = null;
    }
    setLayerRatio(parseInt(sliderLayers.value, 10));
  });
  btnBuildup.addEventListener("click", startBuildupAnimation);
  btnLayersFull.addEventListener("click", () => {
    if (preview.buildupTimer) {
      clearInterval(preview.buildupTimer);
      preview.buildupTimer = null;
    }
    setLayerRatio(100);
  });

  sliderCam.addEventListener("input", () => {
    const deg = parseFloat(sliderCam.value);
    state.camera.angle = (deg * Math.PI) / 180;
    hudCam.textContent = `${Math.round(deg)}°`;
    valCam.textContent = `${Math.round(deg)}°`;
  });
  chkAutoCam.addEventListener("change", () => {
    renderSettings.autoRotateCamera = chkAutoCam.checked;
  });
  btnCamReset.addEventListener("click", () => {
    renderSettings.autoRotateCamera = false;
    chkAutoCam.checked = false;
    state.camera.angle = 0;
    updateHud();
  });

  chkShading.addEventListener("change", () => (renderSettings.useShading = chkShading.checked));
  chkShadow.addEventListener("change", () => (renderSettings.showShadow = chkShadow.checked));
  chkPixelated.addEventListener("change", () => (renderSettings.pixelated = chkPixelated.checked));
  chkWireframe.addEventListener("change", () => (renderSettings.showWireframe = chkWireframe.checked));

  btnPause.addEventListener("click", togglePause);
  btnPillResume.addEventListener("click", togglePause);
  btnRestart.addEventListener("click", () => {
    btnPause.textContent = "一時停止 (P)";
    resetGame();
  });
  btnOverlayRestart.addEventListener("click", () => {
    btnPause.textContent = "一時停止 (P)";
    resetGame();
  });

  // ゲームキャンバスのマウス操作
  gameCanvas.addEventListener("mousemove", (ev) => {
    const rect = gameCanvas.getBoundingClientRect();
    mouse.screenX = ev.clientX - rect.left;
    mouse.screenY = ev.clientY - rect.top;
    mouse.moved = true;
  });
  gameCanvas.addEventListener("mousedown", (ev) => {
    if (ev.button === 0) mouse.down = true;
  });
  window.addEventListener("mouseup", (ev) => {
    if (ev.button === 0) mouse.down = false;
  });

  // キーボード操作
  window.addEventListener("keydown", (ev) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(ev.code)) {
      ev.preventDefault();
    }
    keys[ev.code] = true;

    if (ev.code === "KeyP") {
      togglePause();
    } else if (ev.code === "KeyR") {
      btnPause.textContent = "一時停止 (P)";
      resetGame();
    }
  });
  window.addEventListener("keyup", (ev) => {
    keys[ev.code] = false;
  });

  // キャンバスリサイズ対応
  function resizeGameCanvas() {
    const parent = gameCanvas.parentElement;
    if (!parent) return;
    gameCanvas.width = Math.max(300, parent.clientWidth);
    gameCanvas.height = Math.max(300, parent.clientHeight);
  }
  window.addEventListener("resize", resizeGameCanvas);

  // ============================================================
  // メインアニメーションループ
  // ============================================================
  let lastTimestamp = performance.now();

  function tick(now) {
    const dt = Math.min(0.05, (now - lastTimestamp) / 1000);
    lastTimestamp = now;

    updateGame(dt);
    renderGame();
    renderPreview(dt);

    requestAnimationFrame(tick);
  }

  // 起動
  resizeGameCanvas();
  rebuildSliceGrid();
  resetGame();
  requestAnimationFrame(tick);
})(window);
