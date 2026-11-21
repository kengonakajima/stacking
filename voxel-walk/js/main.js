/**
 * main.js
 * ------------------------------------------------------------
 * 128x128 マルチバイオーム・ボクセルワールドのウォークスルー制御、
 * テラリア式水流ステップ実行、および FPS・ドローコール数などの描画統計表示を行います。
 */
(function (global) {
  "use strict";

  const {
    BLOCK_AIR,
    BLOCK_SIZE,
    BLOCK_SLICES,
    BLOCK_NAMES,
    createWorld,
    createWebGLRenderer,
  } = global.VoxelWalk;

  function makeRandomSeed() {
    return ((Math.floor(Math.random() * 0x7fffffff) ^ (Date.now() & 0x7fffffff)) >>> 0) % 900000 + 100000;
  }

  let worldSeed = makeRandomSeed();
  let world = createWorld(worldSeed);

  const settings = {
    sliceSpacingMult: 1.0,
    maxVisibleSlice: world.maxUsedSlice,
    renderScale: 1.0, // WebGL2 なのでデフォルト 1.0x フル解像度で 60fps！
    useAO: true,
    useEdgeHighlight: true,
    pixelated: true,
    showWireframe: false,
    showClouds: true,
    // 洞窟・遮蔽時の X-Ray 透視設定
    xrayMode: 0, // 0=地形輪郭のみ, 1=うっすら半透明, 2=完全切り抜き
    xrayRadiusBlocks: 5.0,
    occlusionFade: 0,
    isOccluded: false,
    // 昼夜サイクル（0..24時間、デフォルトは明け方 05:30 からスタートして朝焼け→爽やかな昼へ）
    timeOfDay: 5.5,
    autoTime: true,
    sunBrightness: 1.0,
    skyLightColor: [1.0, 0.99, 0.96],
  };

  const camera = {
    x: world.spawnX,
    y: world.spawnY,
    z: world.spawnZ,
    yaw: Math.PI / 4,
    pitchDeg: 45,
    zoom: 4.0,
    screenCenterX: 400,
    screenCenterY: 300,
  };

  const player = {
    x: world.spawnX,
    y: world.spawnY,
    z: world.spawnZ,
    vz: 0,
    radius: 0.27,
    height: 1.5,
    facing: 0,
    onGround: true,
    inWater: false,
    waterDepth: 0,
    isMoving: false,
    walkCycle: 0,
  };

  const keys = Object.create(null);
  const drag = { active: false, lastX: 0, lastY: 0, downX: 0, downY: 0, moved: 0 };

  // ============================================================
  // DOM 要素取得
  // ============================================================
  const viewportPane = document.querySelector(".viewport-pane");
  const worldCanvas = document.getElementById("world-canvas");
  const glRenderer = createWebGLRenderer(worldCanvas);

  const hudFps = document.getElementById("hud-fps");
  const hudTime = document.getElementById("hud-time");
  const hudPos = document.getElementById("hud-pos");
  const hudGround = document.getElementById("hud-ground");
  const hudBiome = document.getElementById("hud-biome");
  const btnPlaceTorchHud = document.getElementById("btn-place-torch-hud");
  const btnResetPos = document.getElementById("btn-reset-pos");
  const btnResetCam = document.getElementById("btn-reset-cam");

  // ============================================================
  // 昼夜サイクル計算（時刻 0..24h → 太陽光強度・空色・背景グラデーション）
  // ============================================================
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpRGB(c1, c2, t) {
    return [
      Math.round(lerp(c1[0], c2[0], t)),
      Math.round(lerp(c1[1], c2[1], t)),
      Math.round(lerp(c1[2], c2[2], t)),
    ];
  }

  let lastBgKey = "";

  function updateDayNightLighting() {
    const h = ((settings.timeOfDay % 24) + 24) % 24;
    let sun = 1.0;
    let lightCol = [1.0, 0.99, 0.96];
    let bgTop = [93, 169, 233];
    let bgBot = [184, 225, 255];

    if (h >= 7 && h < 18) {
      // 昼（7:00 -> 18:00：たっぷり長めの昼間）
      sun = 1.0;
      lightCol = [1.0, 0.99, 0.96];
      bgTop = [93, 169, 233];
      bgBot = [184, 225, 255];
    } else if (h >= 18 && h < 20) {
      // 夕方（18:00 -> 20:00）
      const t = (h - 18) / 2.0;
      if (t < 0.55) {
        const u = t / 0.55;
        sun = lerp(1.0, 0.42, u);
        lightCol = [lerp(1.0, 1.08, u), lerp(0.99, 0.64, u), lerp(0.96, 0.38, u)];
        bgTop = lerpRGB([93, 169, 233], [46, 36, 92], u);
        bgBot = lerpRGB([184, 225, 255], [236, 114, 52], u);
      } else {
        const u = (t - 0.55) / 0.45;
        sun = lerp(0.42, 0.032, u);
        lightCol = [lerp(1.08, 0.24, u), lerp(0.64, 0.34, u), lerp(0.38, 0.58, u)];
        bgTop = lerpRGB([46, 36, 92], [3, 6, 15], u);
        bgBot = lerpRGB([236, 114, 52], [9, 16, 34], u);
      }
    } else if (h >= 20 || h < 5) {
      // 夜（20:00 -> 5:00：真っ暗だが時間進行を早めて短めに）
      sun = 0.032;
      lightCol = [0.24, 0.34, 0.58];
      bgTop = [3, 6, 15];
      bgBot = [9, 16, 34];
    } else {
      // 夜明け（5:00 -> 7:00）
      const t = (h - 5) / 2.0;
      if (t < 0.45) {
        const u = t / 0.45;
        sun = lerp(0.032, 0.45, u);
        lightCol = [lerp(0.24, 1.05, u), lerp(0.34, 0.72, u), lerp(0.58, 0.48, u)];
        bgTop = lerpRGB([3, 6, 15], [38, 54, 108], u);
        bgBot = lerpRGB([9, 16, 34], [244, 158, 72], u);
      } else {
        const u = (t - 0.45) / 0.55;
        sun = lerp(0.45, 1.0, u);
        lightCol = [lerp(1.05, 1.0, u), lerp(0.72, 0.99, u), lerp(0.48, 0.96, u)];
        bgTop = lerpRGB([38, 54, 108], [93, 169, 233], u);
        bgBot = lerpRGB([244, 158, 72], [184, 225, 255], u);
      }
    }

    settings.sunBrightness = sun;
    settings.skyLightColor = lightCol;

    const hh = String(Math.floor(h)).padStart(2, "0");
    const mm = String(Math.floor((h - Math.floor(h)) * 60)).padStart(2, "0");
    const label = h >= 20 || h < 5 ? "夜" : h >= 18 ? "夕" : h < 7 ? "朝" : "昼";
    hudTime.textContent = `${hh}:${mm} (${label})`;

    const bgKey = `${bgTop[0]},${bgTop[1]},${bgBot[0]},${bgBot[1]}`;
    if (bgKey !== lastBgKey && viewportPane) {
      lastBgKey = bgKey;
      viewportPane.style.background = `linear-gradient(180deg, rgb(${bgTop.join(",")}) 0%, rgb(${bgBot.join(",")}) 100%)`;
    }
  }

  /**
   * プレイヤーの身体各点からカメラ視線方向へスライス単位でレイマーチし、
   * 真上に天井があるかではなく「カメラから見てプレイヤーが実際に隠れているか」を正確に判定する。
   */
  function isPointOccludedFromCamera(ox, oy, startSlice, rayDx, rayDy, maxSlice) {
    const invSlices = 1 / BLOCK_SLICES;
    for (let s = startSlice + 1; s < maxSlice; s++) {
      const dz = (s - startSlice) * invSlices;
      const rx = Math.floor(ox + rayDx * dz);
      const ry = Math.floor(oy + rayDy * dz);
      if (rx < 0 || ry < 0 || rx >= world.sizeX || ry >= world.sizeY) {
        break;
      }
      const bz = Math.floor(s * invSlices);
      const lz = s - bz * BLOCK_SLICES;
      if (bz >= world.sizeZ) {
        // 最上段ブロックの露出上面キャップ（共有境界スライス lz === 0）
        if (bz === world.sizeZ && lz === 0 && world.getBlock(rx, ry, world.sizeZ - 1) !== BLOCK_AIR) {
          return true;
        }
        break;
      }
      if (world.getBlock(rx, ry, bz) !== BLOCK_AIR) {
        return true;
      }
      // 1段下ブロックの露出上面キャップ（lz === 0）も描画されるため遮蔽として判定
      if (lz === 0 && bz > 0 && world.getBlock(rx, ry, bz - 1) !== BLOCK_AIR) {
        return true;
      }
    }
    return false;
  }

  function checkPlayerOccluded() {
    const pitchRad = (camera.pitchDeg * Math.PI) / 180;
    const cotPitch = Math.cos(pitchRad) / Math.max(0.15, Math.sin(pitchRad));
    const stepPerZ = cotPitch * settings.sliceSpacingMult;
    const cosYaw = Math.cos(camera.yaw);
    const sinYaw = Math.sin(camera.yaw);
    const rayDx = stepPerZ * sinYaw;
    const rayDy = stepPerZ * cosYaw;

    const baseSlice = Math.round(player.z * BLOCK_SLICES);
    const maxSlice = Math.min(world.maxUsedSlice, settings.maxVisibleSlice);

    // 画面右方向のオフセット（左右の肩のサンプル位置）
    const rightX = cosYaw * 0.22;
    const rightY = -sinYaw * 0.22;

    // 頭・胴体・足元・左肩・右肩の5点すべてがカメラ視線から遮蔽されている（＝完全に隠れた）ときだけ透視ON
    const samples = [
      [player.x, player.y, baseSlice + 10], // 頭・顔
      [player.x, player.y, baseSlice + 6], // 胴体中央
      [player.x, player.y, baseSlice + 2], // 下半身・足元
      [player.x - rightX, player.y - rightY, baseSlice + 8], // 左肩
      [player.x + rightX, player.y + rightY, baseSlice + 8], // 右肩
    ];
    for (let i = 0; i < samples.length; i++) {
      const sp = samples[i];
      if (!isPointOccludedFromCamera(sp[0], sp[1], sp[2], rayDx, rayDy, maxSlice)) {
        return false;
      }
    }
    return true;
  }

  // ============================================================
  // 3D ボクセル当たり判定
  // ============================================================
  function hasSolidAtLayer(px, py, bz) {
    const r = player.radius;
    const minX = Math.floor(px - r);
    const maxX = Math.floor(px + r);
    const minY = Math.floor(py - r);
    const maxY = Math.floor(py + r);
    for (let by = minY; by <= maxY; by++) {
      for (let bx = minX; bx <= maxX; bx++) {
        if (world.getBlock(bx, by, bz) !== BLOCK_AIR) {
          return true;
        }
      }
    }
    return false;
  }

  function collidesAt(px, py, pz) {
    const r = player.radius;
    const minZ = Math.floor(pz + 0.001);
    const maxZ = Math.floor(pz + player.height - 0.001);

    if (px - r < 0 || px + r > world.sizeX || py - r < 0 || py + r > world.sizeY) {
      return true;
    }

    for (let bz = minZ; bz <= maxZ; bz++) {
      if (hasSolidAtLayer(px, py, bz)) {
        return true;
      }
    }
    return false;
  }

  function resetPlayerPosition() {
    player.x = world.spawnX;
    player.y = world.spawnY;
    player.z = world.spawnZ;
    player.vz = 0;
    player.facing = 0;
    player.onGround = true;
    camera.x = player.x;
    camera.y = player.y;
    camera.z = player.z;
  }

  function resetCameraView() {
    camera.yaw = Math.PI / 4;
    camera.pitchDeg = 45;
    camera.zoom = 4.0;
  }

  // ============================================================
  // プレイヤー移動・ジャンプ・水中遊泳
  // ============================================================
  function updatePlayer(dt) {
    const yawSpeed = 1.7;
    if (keys["KeyQ"]) {
      camera.yaw -= yawSpeed * dt;
    }
    if (keys["KeyE"]) {
      camera.yaw += yawSpeed * dt;
    }

    const wFeet = world.getWaterLevelAt(player.x, player.y, player.z + 0.08);
    player.waterDepth = wFeet;
    player.inWater = wFeet > 0;

    let ix = 0;
    let iy = 0;
    if (keys["KeyW"] || keys["ArrowUp"]) iy -= 1;
    if (keys["KeyS"] || keys["ArrowDown"]) iy += 1;
    if (keys["KeyA"] || keys["ArrowLeft"]) ix -= 1;
    if (keys["KeyD"] || keys["ArrowRight"]) ix += 1;

    player.isMoving = ix !== 0 || iy !== 0;

    if (player.isMoving) {
      const len = Math.hypot(ix, iy);
      ix /= len;
      iy /= len;

      const cos = Math.cos(-camera.yaw);
      const sin = Math.sin(-camera.yaw);
      const wx = ix * cos - iy * sin;
      const wy = ix * sin + iy * cos;

      const walkSpeed = player.inWater ? 4.2 : 6.0;
      const stepX = wx * walkSpeed * dt;
      const stepY = wy * walkSpeed * dt;

      const targetFacing = Math.atan2(wy, wx);
      let diff = targetFacing - player.facing;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      player.facing += diff * Math.min(1, dt * 14);

      const nextX = player.x + stepX;
      if (!collidesAt(nextX, player.y, player.z)) {
        player.x = nextX;
      }

      const nextY = player.y + stepY;
      if (!collidesAt(player.x, nextY, player.z)) {
        player.y = nextY;
      }

      player.walkCycle += dt;
    }

    if (keys["Space"]) {
      if (player.onGround) {
        // 2ブロック段差を1回のジャンプで余裕を持って登れる初速（最高到達 約2.4ブロック）
        player.vz = 10.3;
        player.onGround = false;
      } else if (player.inWater) {
        player.vz = Math.min(6.4, player.vz + 24 * dt);
      }
    }

    const gravity = player.inWater ? 9.5 : 22.0;
    player.vz -= gravity * dt;
    if (player.inWater && player.vz < -2.6) {
      player.vz = -2.6;
    }
    const nextZ = player.z + player.vz * dt;

    if (player.vz <= 0) {
      if (nextZ <= 0) {
        player.z = 0;
        player.vz = 0;
        player.onGround = true;
      } else {
        const startBz = Math.floor(player.z - 0.0001);
        const endBz = Math.floor(nextZ);
        let landed = false;
        for (let bz = startBz; bz >= endBz; bz--) {
          if (hasSolidAtLayer(player.x, player.y, bz)) {
            player.z = bz + 1;
            player.vz = 0;
            player.onGround = true;
            landed = true;
            break;
          }
        }
        if (!landed) {
          player.z = nextZ;
          player.onGround = false;
        }
      }
    } else {
      const startCeil = Math.floor(player.z + player.height);
      const endCeil = Math.floor(nextZ + player.height);
      let hitCeiling = false;
      for (let bz = startCeil; bz <= endCeil; bz++) {
        if (hasSolidAtLayer(player.x, player.y, bz)) {
          player.z = bz - player.height - 0.001;
          player.vz = 0;
          hitCeiling = true;
          break;
        }
      }
      if (!hitCeiling) {
        player.z = nextZ;
      }
      player.onGround = false;
    }

    const follow = Math.min(1, dt * 7);
    camera.x += (player.x - camera.x) * follow;
    camera.y += (player.y - camera.y) * follow;
    camera.z += (player.z - camera.z) * Math.min(1, dt * 4.5);

    hudPos.textContent = `${player.x.toFixed(1)}, ${player.y.toFixed(1)}, ${player.z.toFixed(1)}`;
    hudBiome.textContent = world.getBiomeNameAt(player.x, player.y, player.z + 1.0);
    const floor = world.findFloorBelow(player.x, player.y, player.z + 0.05);
    if (player.inWater) {
      hudGround.textContent = `水中 (${player.waterDepth}/8)`;
    } else if (player.onGround) {
      hudGround.textContent = BLOCK_NAMES[floor.blockType] || "地面";
    } else {
      hudGround.textContent = "空中";
    }

    // 洞窟・崖裏による遮蔽を判定し、X-Ray 透過フェードを滑らかに補間
    const occluded = checkPlayerOccluded();
    settings.isOccluded = occluded;
    const targetFade = occluded ? 1.0 : 0.0;
    settings.occlusionFade += (targetFade - settings.occlusionFade) * Math.min(1, dt * 8.5);
    if (Math.abs(settings.occlusionFade - targetFade) < 0.005) {
      settings.occlusionFade = targetFade;
    }
  }

  // ============================================================
  // 画面クリック位置から 3D ボクセルブロックを厳密レイキャストして1発破壊
  // ============================================================
  function pickBlockAtClientPos(clientX, clientY) {
    const rect = worldCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const rScale = settings.renderScale || 1.0;
    const clickX = (clientX - rect.left) * (worldCanvas.width / rect.width);
    const clickY = (clientY - rect.top) * (worldCanvas.height / rect.height);

    const viewW = worldCanvas.width;
    const viewH = worldCanvas.height;
    const effZoom = camera.zoom * rScale;
    const centerX = viewW * 0.5;
    const centerY = viewH * 0.5 + 12 * rScale;

    const pitchRad = (camera.pitchDeg * Math.PI) / 180;
    const squashY = Math.sin(pitchRad);
    const sliceUnitScale = BLOCK_SIZE / BLOCK_SLICES;
    const liftPerSlice = Math.cos(pitchRad) * effZoom * sliceUnitScale * settings.sliceSpacingMult;
    const blockScreenPx = BLOCK_SIZE * effZoom;
    const cosYaw = Math.cos(camera.yaw);
    const sinYaw = Math.sin(camera.yaw);
    const camBaseSlice = camera.z * BLOCK_SLICES;

    // 透視モード中はカットされている屋根スライスを貫通して洞窟内部のブロックを掘れるようにする
    const pRelX = (player.x - camera.x) * blockScreenPx;
    const pRelY = (player.y - camera.y) * blockScreenPx;
    const pScreenX = centerX + (pRelX * cosYaw - pRelY * sinYaw);
    const pBodySlice = player.z * BLOCK_SLICES + 6.2;
    const pScreenY =
      centerY - (pBodySlice - camBaseSlice) * liftPerSlice + (pRelX * sinYaw + pRelY * cosYaw) * squashY;
    const clickDistToPlayer = Math.hypot(clickX - pScreenX, clickY - pScreenY);
    const xrayRadiusPx = (settings.xrayRadiusBlocks || 5.0) * blockScreenPx;
    const playerBaseSlice = Math.round(player.z * BLOCK_SLICES);
    const xrayActive = settings.occlusionFade > 0.35 && clickDistToPlayer < xrayRadiusPx;
    const xrayCutSlice = clickDistToPlayer < blockScreenPx * 1.35 ? playerBaseSlice + 4 : playerBaseSlice + 12;

    const topSlice = Math.min(world.maxUsedSlice - 1, settings.maxVisibleSlice - 1);
    const rx = clickX - centerX;
    for (let s = topSlice; s >= 0; s--) {
      if (xrayActive && s >= xrayCutSlice) continue;
      const ryUnsq = (clickY - centerY + (s - camBaseSlice) * liftPerSlice) / Math.max(0.15, squashY);
      const bx = Math.floor(camera.x + (rx * cosYaw + ryUnsq * sinYaw) / blockScreenPx);
      const by = Math.floor(camera.y + (-rx * sinYaw + ryUnsq * cosYaw) / blockScreenPx);
      if (bx < 0 || by < 0 || bx >= world.sizeX || by >= world.sizeY) continue;

      const bz = Math.floor(s / BLOCK_SLICES);
      const lz = s - bz * BLOCK_SLICES;
      if (bz < world.sizeZ && world.getBlock(bx, by, bz) !== BLOCK_AIR) {
        return { x: bx, y: by, z: bz };
      }
      if (lz === 0 && bz > 0 && world.getBlock(bx, by, bz - 1) !== BLOCK_AIR) {
        return { x: bx, y: by, z: bz - 1 };
      }
    }
    return null;
  }

  // ============================================================
  // 入力・UI イベント配線
  // ============================================================
  worldCanvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    drag.active = true;
    drag.lastX = ev.clientX;
    drag.lastY = ev.clientY;
    drag.downX = ev.clientX;
    drag.downY = ev.clientY;
    drag.moved = 0;
  });
  window.addEventListener("mousemove", (ev) => {
    if (drag.active) {
      const dx = ev.clientX - drag.lastX;
      const dy = ev.clientY - drag.lastY;
      drag.lastX = ev.clientX;
      drag.lastY = ev.clientY;
      drag.moved += Math.hypot(dx, dy);
      if (drag.moved > 4) {
        camera.yaw += dx * 0.008;
        camera.pitchDeg = Math.max(25, Math.min(85, camera.pitchDeg + dy * 0.28));
      }
    }
  });
  window.addEventListener("mouseup", (ev) => {
    if (drag.active && drag.moved <= 5) {
      const hit = pickBlockAtClientPos(ev.clientX, ev.clientY);
      if (hit) {
        world.destroyBlockAt(hit.x, hit.y, hit.z);
      }
    }
    drag.active = false;
  });

  worldCanvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY > 0 ? 0.90 : 1.11;
      camera.zoom = Math.max(0.8, Math.min(7.5, camera.zoom * factor));
    },
    { passive: false }
  );

  function placeTorchAtPlayer() {
    // まず足元、埋まっていれば1歩前方へ設置
    if (world.placeTorchAt(player.x, player.y, player.z + 0.1)) return;
    world.placeTorchAt(player.x + Math.cos(player.facing) * 0.9, player.y + Math.sin(player.facing) * 0.9, player.z + 0.1);
  }

  btnPlaceTorchHud.addEventListener("click", placeTorchAtPlayer);
  btnResetPos.addEventListener("click", resetPlayerPosition);
  btnResetCam.addEventListener("click", resetCameraView);

  window.addEventListener("keydown", (ev) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(ev.code)) {
      ev.preventDefault();
    }
    keys[ev.code] = true;
    if (ev.code === "KeyR") {
      resetPlayerPosition();
    } else if (ev.code === "KeyF") {
      placeTorchAtPlayer();
    } else if (ev.code === "KeyX") {
      world.removeTorchNear(player.x, player.y, player.z + 0.3);
    }
  });
  window.addEventListener("keyup", (ev) => {
    keys[ev.code] = false;
  });

  function resizeWorldCanvas() {
    const parent = worldCanvas.parentElement;
    if (!parent) return;
    worldCanvas.width = Math.max(200, Math.round(parent.clientWidth * settings.renderScale));
    worldCanvas.height = Math.max(200, Math.round(parent.clientHeight * settings.renderScale));
  }
  window.addEventListener("resize", resizeWorldCanvas);

  // ============================================================
  // メインループ
  // ============================================================
  let lastTime = performance.now();
  let waterAccum = 0;

  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  let currentFps = 60;
  let statsUiTimer = 0;

  function tick(now) {
    const rawDt = (now - lastTime) / 1000;
    const dt = Math.min(0.05, Math.max(0.001, rawDt));
    lastTime = now;

    // FPS 計測（0.25秒窓で滑らかに算出）
    fpsFrames++;
    const fpsElapsed = now - fpsWindowStart;
    if (fpsElapsed >= 250) {
      currentFps = (fpsFrames * 1000) / fpsElapsed;
      fpsFrames = 0;
      fpsWindowStart = now;
    }

    // 昼夜サイクル進行（昼44秒・朝夕各8秒・夜は2.5倍速で約14.5秒と短めに）
    if (settings.autoTime) {
      const h = ((settings.timeOfDay % 24) + 24) % 24;
      const isNight = h >= 20 || h < 5;
      const hoursPerSec = isNight ? 0.62 : 0.25;
      settings.timeOfDay = (settings.timeOfDay + dt * hoursPerSec) % 24;
    }
    updateDayNightLighting();

    updatePlayer(dt);
    world.updateSheep(dt, player);
    world.updateTrees(dt, now * 0.001, player);

    // 水流ステップ
    waterAccum += dt;
    if (waterAccum >= 0.085) {
      waterAccum = 0;
      if (!world.isWaterSettled()) {
        world.stepWater();
      }
    }

    glRenderer.render(world, player, camera, settings, now * 0.001);

    statsUiTimer += dt;
    if (statsUiTimer >= 0.12) {
      statsUiTimer = 0;
      hudFps.textContent = `${Math.round(currentFps)} fps`;
    }

    requestAnimationFrame(tick);
  }

  // 起動
  resizeWorldCanvas();
  resetPlayerPosition();
  requestAnimationFrame(tick);
})(window);
