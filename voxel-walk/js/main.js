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
    BLOCK_SLICES,
    BLOCK_NAMES,
    PREVIEW_MODELS,
    createWorld,
    createWebGLRenderer,
    drawSingleModelPreview,
  } = global.VoxelWalk;

  let worldSeed = 104729;
  let world = createWorld(worldSeed);

  const settings = {
    sliceSpacingMult: 1.0,
    maxVisibleSlice: world.maxUsedSlice,
    renderScale: 1.0, // WebGL2 なのでデフォルト 1.0x フル解像度で 60fps！
    useAO: true,
    useEdgeHighlight: true,
    pixelated: true,
    showWireframe: false,
    // 洞窟・遮蔽時の X-Ray 透視設定
    xrayMode: 0, // 0=地形輪郭のみ, 1=うっすら半透明, 2=完全切り抜き
    xrayRadiusBlocks: 5.0,
    occlusionFade: 0,
    isOccluded: false,
    // 昼夜サイクル（0..24時間、デフォルトは昼過ぎ 15:30 からスタートして夕焼け→夜へ自然に移行）
    timeOfDay: 15.5,
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
  const drag = { active: false, lastX: 0, lastY: 0 };

  const preview = {
    modelId: "grass",
    angle: Math.PI / 4,
    dragging: false,
    lastDragX: 0,
    highlightLayer: null,
    buildupTimer: null,
    sliceCells: [],
  };

  // ============================================================
  // DOM 要素取得
  // ============================================================
  const viewportPane = document.querySelector(".viewport-pane");
  const worldCanvas = document.getElementById("world-canvas");
  const glRenderer = createWebGLRenderer(worldCanvas);
  const previewCanvas = document.getElementById("preview-canvas");
  const previewCtx = previewCanvas.getContext("2d");

  const hudFps = document.getElementById("hud-fps");
  const hudTime = document.getElementById("hud-time");
  const hudPos = document.getElementById("hud-pos");
  const hudGround = document.getElementById("hud-ground");
  const hudBiome = document.getElementById("hud-biome");
  const btnPlaceTorchHud = document.getElementById("btn-place-torch-hud");
  const btnResetPos = document.getElementById("btn-reset-pos");
  const btnResetCam = document.getElementById("btn-reset-cam");

  // 描画統計パネル要素
  const statFps = document.getElementById("stat-fps");
  const statRenderMs = document.getElementById("stat-render-ms");
  const statDrawTotal = document.getElementById("stat-draw-total");
  const statDrawBreak = document.getElementById("stat-draw-break");
  const statSlices = document.getElementById("stat-slices");
  const statCrop = document.getElementById("stat-crop");
  const statWaterMs = document.getElementById("stat-water-ms");
  const statWorldMeta = document.getElementById("stat-world-meta");
  const valRenderScale = document.getElementById("val-render-scale");

  const modelTabs = document.getElementById("model-tabs");
  const previewCaption = document.getElementById("preview-caption");
  const hoverLayerInfo = document.getElementById("hover-layer-info");
  const sliceGrid = document.getElementById("slice-grid");

  const valWaterTotal = document.getElementById("val-water-total");
  const btnReflowWater = document.getElementById("btn-reflow-water");
  const btnRegenWorld = document.getElementById("btn-regen-world");
  const btnGotoCave = document.getElementById("btn-goto-cave");
  const btnPlaceTorch = document.getElementById("btn-place-torch");
  const btnRemoveTorch = document.getElementById("btn-remove-torch");
  const valLightInfo = document.getElementById("val-light-info");
  const sliderTime = document.getElementById("slider-time");
  const valTime = document.getElementById("val-time");
  const chkAutoTime = document.getElementById("chk-auto-time");
  const sliderXrayRadius = document.getElementById("slider-xray-radius");
  const valXrayRadius = document.getElementById("val-xray-radius");
  const badgeOcclusion = document.getElementById("badge-occlusion");

  const sliderSpacing = document.getElementById("slider-spacing");
  const valSpacing = document.getElementById("val-spacing");
  const sliderCutaway = document.getElementById("slider-cutaway");
  const valCutaway = document.getElementById("val-cutaway");
  const btnBuildup = document.getElementById("btn-buildup");
  const btnCutawayFull = document.getElementById("btn-cutaway-full");
  const sliderYaw = document.getElementById("slider-yaw");
  const valYaw = document.getElementById("val-yaw");
  const sliderPitch = document.getElementById("slider-pitch");
  const valPitch = document.getElementById("val-pitch");

  const chkAO = document.getElementById("chk-ao");
  const chkEdge = document.getElementById("chk-edge");
  const chkPixelated = document.getElementById("chk-pixelated");
  const chkWireframe = document.getElementById("chk-wireframe");

  function updateWaterHud() {
    const cur = world.computeCurrentTotalWater();
    const init = world.getInitialTotalWater();
    const status = world.isWaterSettled() ? "静止" : "流動中";
    valWaterTotal.textContent = `${cur} / ${init} (${status})`;
  }

  function syncWorldMeta() {
    sliderCutaway.max = String(world.maxUsedSlice);
    settings.maxVisibleSlice = world.maxUsedSlice;
    sliderCutaway.value = String(world.maxUsedSlice);
    valCutaway.textContent = `${world.maxUsedSlice} / ${world.maxUsedSlice}`;
    statWorldMeta.textContent = `${world.sizeX}×${world.sizeY}×${world.sizeZ} (溶岩池 ${world.lavaPoolCount} / ベイク ${world.initialBakeMs.toFixed(0)}ms)`;
    updateWaterHud();
  }

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
    const timeText = `${hh}:${mm} (${label})`;
    hudTime.textContent = timeText;
    valTime.textContent = timeText;
    sliderTime.value = h.toFixed(2);

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
    syncCameraUI();
  }

  function regenerateWorld() {
    if (preview.buildupTimer) {
      clearInterval(preview.buildupTimer);
      preview.buildupTimer = null;
    }
    worldSeed = (worldSeed * 1103515245 + 12345) & 0x7fffffff;
    world = createWorld(worldSeed);
    syncWorldMeta();
    resetPlayerPosition();
  }

  function normalizeDeg(deg) {
    return (((deg + 180) % 360) + 360) % 360 - 180;
  }

  function syncCameraUI() {
    const yawDeg = normalizeDeg(Math.round((camera.yaw * 180) / Math.PI));
    const pitchDeg = Math.round(camera.pitchDeg);
    sliderYaw.value = String(yawDeg);
    valYaw.textContent = `${yawDeg}°`;
    sliderPitch.value = String(pitchDeg);
    valPitch.textContent = `${pitchDeg}°`;

    document.querySelectorAll("[data-pitch]").forEach((btn) => {
      const v = parseFloat(btn.dataset.pitch);
      btn.classList.toggle("active", Math.abs(v - pitchDeg) <= 1);
    });
  }

  // ============================================================
  // プレイヤー移動・ジャンプ・水中遊泳
  // ============================================================
  function updatePlayer(dt) {
    const yawSpeed = 1.7;
    if (keys["KeyQ"]) {
      camera.yaw -= yawSpeed * dt;
      syncCameraUI();
    }
    if (keys["KeyE"]) {
      camera.yaw += yawSpeed * dt;
      syncCameraUI();
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
        player.vz = 7.6;
        player.onGround = false;
      } else if (player.inWater) {
        player.vz = Math.min(5.2, player.vz + 22 * dt);
      }
    }

    const gravity = player.inWater ? 9.5 : 20.0;
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
    badgeOcclusion.textContent = occluded ? "透視ON（遮蔽中）" : "待機中（視界良好）";
    badgeOcclusion.classList.toggle("active", occluded);

    // 現在位置の明るさ (0..15) と松明本数を表示
    const curLight = world.getLightAt(player.x, player.y, player.z + 0.3);
    valLightInfo.textContent = `光 ${curLight.block}/15 · 空 ${curLight.sky}/15 (松明 ${world.getTorchCount()}本)`;
  }

  // ============================================================
  // 右パネル: 単体モデルプレビュー & スライスシート
  // ============================================================
  function rebuildSliceGrid() {
    const model = PREVIEW_MODELS[preview.modelId];
    sliceGrid.innerHTML = "";
    preview.sliceCells = [];

    for (let z = 0; z < model.layerCount; z++) {
      const cell = document.createElement("div");
      cell.className = "slice-cell";

      const thumb = document.createElement("canvas");
      thumb.width = model.width;
      thumb.height = model.height;
      const tCtx = thumb.getContext("2d");
      tCtx.imageSmoothingEnabled = false;
      tCtx.drawImage(model.canvases[z], 0, 0);

      const label = document.createElement("span");
      label.textContent = `Z=${z}`;

      cell.appendChild(thumb);
      cell.appendChild(label);

      cell.addEventListener("mouseenter", () => {
        preview.highlightLayer = z;
        cell.classList.add("highlighted");
        hoverLayerInfo.textContent = `Z=${z} / ${model.layerCount - 1}`;
      });
      cell.addEventListener("mouseleave", () => {
        preview.highlightLayer = null;
        cell.classList.remove("highlighted");
        hoverLayerInfo.textContent = "層にカーソルで強調";
      });

      sliceGrid.appendChild(cell);
      preview.sliceCells.push(cell);
    }

    previewCaption.textContent = `${model.name}：${model.layerCount}枚の2Dスライス（Z倍率 ${settings.sliceSpacingMult.toFixed(2)}x）`;
  }

  function renderPreview(dt) {
    if (!preview.dragging) {
      preview.angle += dt * 0.75;
    }

    const model = PREVIEW_MODELS[preview.modelId];
    const w = previewCanvas.width;
    const h = previewCanvas.height;
    previewCtx.clearRect(0, 0, w, h);

    const scale = model.id === "player" ? 5.6 : 7.8;
    const pitchRad = (camera.pitchDeg * Math.PI) / 180;
    const unitScale = model.id === "player" ? 1.0 : 6 / 8;
    const totalLift = (model.layerCount - 1) * Math.cos(pitchRad) * scale * unitScale * settings.sliceSpacingMult;
    const baseY = Math.min(h - 24, h / 2 + totalLift * 0.48 + 10);

    drawSingleModelPreview(previewCtx, model, {
      x: w / 2,
      y: baseY,
      angle: preview.angle,
      pitchDeg: camera.pitchDeg,
      scale,
      sliceSpacingMult: settings.sliceSpacingMult,
      pixelated: settings.pixelated,
      showWireframe: settings.showWireframe,
      highlightLayer: preview.highlightLayer,
    });
  }

  // ============================================================
  // UI イベント配線
  // ============================================================
  function setSpacingMult(val) {
    settings.sliceSpacingMult = val;
    sliderSpacing.value = String(val);
    valSpacing.textContent = `${val.toFixed(2)}x`;
    document.querySelectorAll("[data-spacing]").forEach((btn) => {
      const v = parseFloat(btn.dataset.spacing);
      btn.classList.toggle("active", Math.abs(v - val) < 0.04);
    });
    const model = PREVIEW_MODELS[preview.modelId];
    previewCaption.textContent = `${model.name}：${model.layerCount}枚の2Dスライス（Z倍率 ${val.toFixed(2)}x）`;
  }

  function setCutaway(sliceCount) {
    settings.maxVisibleSlice = sliceCount;
    sliderCutaway.value = String(sliceCount);
    valCutaway.textContent = `${sliceCount} / ${world.maxUsedSlice}`;
  }

  function startBuildupAnimation() {
    if (preview.buildupTimer) {
      clearInterval(preview.buildupTimer);
      preview.buildupTimer = null;
    }
    let current = 1;
    setCutaway(current);
    preview.buildupTimer = setInterval(() => {
      current += 2;
      if (current >= world.maxUsedSlice) {
        clearInterval(preview.buildupTimer);
        preview.buildupTimer = null;
        setCutaway(world.maxUsedSlice);
        return;
      }
      setCutaway(current);
    }, 45);
  }

  modelTabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-model]");
    if (!btn) return;
    preview.modelId = btn.dataset.model;
    modelTabs.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    preview.highlightLayer = null;
    rebuildSliceGrid();
  });

  previewCanvas.addEventListener("mousedown", (ev) => {
    preview.dragging = true;
    preview.lastDragX = ev.clientX;
  });

  worldCanvas.addEventListener("mousedown", (ev) => {
    drag.active = true;
    drag.lastX = ev.clientX;
    drag.lastY = ev.clientY;
  });
  window.addEventListener("mousemove", (ev) => {
    if (preview.dragging) {
      const dx = ev.clientX - preview.lastDragX;
      preview.lastDragX = ev.clientX;
      preview.angle += dx * 0.02;
    }
    if (drag.active) {
      const dx = ev.clientX - drag.lastX;
      const dy = ev.clientY - drag.lastY;
      drag.lastX = ev.clientX;
      drag.lastY = ev.clientY;
      camera.yaw += dx * 0.008;
      camera.pitchDeg = Math.max(25, Math.min(85, camera.pitchDeg + dy * 0.28));
      syncCameraUI();
    }
  });
  window.addEventListener("mouseup", () => {
    preview.dragging = false;
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

  document.querySelectorAll("[data-rscale]").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.renderScale = parseFloat(btn.dataset.rscale);
      valRenderScale.textContent = `${settings.renderScale.toFixed(2)}x`;
      document.querySelectorAll("[data-rscale]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      resizeWorldCanvas();
    });
  });

  sliderSpacing.addEventListener("input", () => setSpacingMult(parseFloat(sliderSpacing.value)));
  document.querySelectorAll("[data-spacing]").forEach((btn) => {
    btn.addEventListener("click", () => setSpacingMult(parseFloat(btn.dataset.spacing)));
  });

  sliderCutaway.addEventListener("input", () => {
    if (preview.buildupTimer) {
      clearInterval(preview.buildupTimer);
      preview.buildupTimer = null;
    }
    setCutaway(parseInt(sliderCutaway.value, 10));
  });
  btnBuildup.addEventListener("click", startBuildupAnimation);
  btnCutawayFull.addEventListener("click", () => {
    if (preview.buildupTimer) {
      clearInterval(preview.buildupTimer);
      preview.buildupTimer = null;
    }
    setCutaway(world.maxUsedSlice);
  });

  btnReflowWater.addEventListener("click", () => {
    world.resetWaterToHighlands();
    updateWaterHud();
  });
  btnRegenWorld.addEventListener("click", regenerateWorld);
  btnGotoCave.addEventListener("click", () => {
    player.x = world.caveEntranceX;
    player.y = world.caveEntranceY;
    player.z = world.caveEntranceZ;
    player.vz = 0;
    player.facing = 0;
    camera.x = player.x;
    camera.y = player.y;
    camera.z = player.z;
  });

  function placeTorchAtPlayer() {
    // まず足元、埋まっていれば1歩前方へ設置
    if (world.placeTorchAt(player.x, player.y, player.z + 0.1)) return;
    world.placeTorchAt(player.x + Math.cos(player.facing) * 0.9, player.y + Math.sin(player.facing) * 0.9, player.z + 0.1);
  }

  btnPlaceTorch.addEventListener("click", placeTorchAtPlayer);
  btnPlaceTorchHud.addEventListener("click", placeTorchAtPlayer);
  btnRemoveTorch.addEventListener("click", () => {
    world.removeTorchNear(player.x, player.y, player.z + 0.3);
  });

  sliderTime.addEventListener("input", () => {
    settings.timeOfDay = parseFloat(sliderTime.value);
    updateDayNightLighting();
  });
  document.querySelectorAll("[data-time]").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.timeOfDay = parseFloat(btn.dataset.time);
      updateDayNightLighting();
    });
  });
  chkAutoTime.addEventListener("change", () => {
    settings.autoTime = chkAutoTime.checked;
  });

  document.querySelectorAll("[data-xray]").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.xrayMode = parseInt(btn.dataset.xray, 10);
      document.querySelectorAll("[data-xray]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
    });
  });

  sliderXrayRadius.addEventListener("input", () => {
    settings.xrayRadiusBlocks = parseFloat(sliderXrayRadius.value);
    valXrayRadius.textContent = `${settings.xrayRadiusBlocks.toFixed(1)} blk`;
  });

  sliderYaw.addEventListener("input", () => {
    const deg = parseFloat(sliderYaw.value);
    camera.yaw = (deg * Math.PI) / 180;
    syncCameraUI();
  });
  sliderPitch.addEventListener("input", () => {
    camera.pitchDeg = parseFloat(sliderPitch.value);
    syncCameraUI();
  });
  document.querySelectorAll("[data-pitch]").forEach((btn) => {
    btn.addEventListener("click", () => {
      camera.pitchDeg = parseFloat(btn.dataset.pitch);
      syncCameraUI();
    });
  });

  chkAO.addEventListener("change", () => (settings.useAO = chkAO.checked));
  chkEdge.addEventListener("change", () => (settings.useEdgeHighlight = chkEdge.checked));
  chkPixelated.addEventListener("change", () => (settings.pixelated = chkPixelated.checked));
  chkWireframe.addEventListener("change", () => (settings.showWireframe = chkWireframe.checked));

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
  // メインループ ＋ リアルタイム描画統計計測
  // ============================================================
  let lastTime = performance.now();
  let waterAccum = 0;
  let lastWaterStepMs = 0;

  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  let currentFps = 60;
  let smoothRenderMs = 0;
  let statsUiTimer = 0;
  let previewToggle = 0;

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
    world.updateTrees(dt, now * 0.001, player);

    // 水流ステップ計測
    waterAccum += dt;
    if (waterAccum >= 0.085) {
      waterAccum = 0;
      if (world.isWaterSettled()) {
        lastWaterStepMs = 0;
      } else {
        const wt0 = performance.now();
        world.stepWater();
        lastWaterStepMs = performance.now() - wt0;
      }
      updateWaterHud();
    }

    const rStats = glRenderer.render(world, player, camera, settings, now * 0.001);
    smoothRenderMs = smoothRenderMs === 0 ? rStats.renderMs : smoothRenderMs * 0.85 + rStats.renderMs * 0.15;

    // 右側単体プレビューは30fps間引き
    previewToggle ^= 1;
    if (previewToggle || preview.dragging) {
      renderPreview(dt * (preview.dragging ? 1 : 2));
    }

    // 描画統計 UI を約 8Hz で更新
    statsUiTimer += dt;
    if (statsUiTimer >= 0.12) {
      statsUiTimer = 0;
      const fpsStr = `${currentFps.toFixed(1)} fps`;
      hudFps.textContent = `${Math.round(currentFps)} fps`;
      statFps.textContent = fpsStr;
      statRenderMs.textContent = `${smoothRenderMs.toFixed(2)} ms`;
      statDrawTotal.textContent = `${rStats.totalDrawCalls} calls (${rStats.backend})`;
      statDrawBreak.textContent = `地形 ${rStats.worldDrawCalls} / 水 ${rStats.waterDrawCalls} / 他 ${rStats.miscDrawCalls}`;
      statSlices.textContent = `${rStats.drawnSlices} / ${rStats.totalSlices} 層 (Instanced)`;
      statCrop.textContent = `${Math.round(rStats.cropRatio * 100)}% (${worldCanvas.width}×${worldCanvas.height})`;
      statWaterMs.textContent = world.isWaterSettled()
        ? "0.00 ms (静止)"
        : `${lastWaterStepMs.toFixed(2)} ms`;
    }

    requestAnimationFrame(tick);
  }

  // 起動
  resizeWorldCanvas();
  syncWorldMeta();
  rebuildSliceGrid();
  syncCameraUI();
  resetPlayerPosition();
  requestAnimationFrame(tick);
})(window);
