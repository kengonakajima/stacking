/**
 * main.js
 * ------------------------------------------------------------
 * ボクセルワールドのウォークスルー操作（移動・ジャンプ・段差登り・当たり判定）と
 * カメラ操作、右側観察パネルのUI制御を行います。
 */
(function (global) {
  "use strict";

  const {
    BLOCK_AIR,
    BLOCK_NAMES,
    PREVIEW_MODELS,
    createWorld,
    renderVoxelWorld,
    drawSingleModelPreview,
  } = global.VoxelWalk;

  const world = createWorld();

  // ============================================================
  // 描画・観察設定
  // ============================================================
  const settings = {
    sliceSpacingMult: 1.0,
    maxVisibleSlice: world.maxUsedSlice,
    useAO: true,
    pixelated: true,
    showWireframe: false,
  };

  // カメラ状態（初期はアイソメトリック風の45°/45°）
  const camera = {
    x: 10.5,
    y: 10.5,
    z: 2.0,
    yaw: Math.PI / 4, // 45°
    pitchDeg: 45,
    zoom: 3.4,
    screenCenterX: 400,
    screenCenterY: 300,
  };

  // プレイヤー状態（ブロック座標系）
  const player = {
    x: 10.5,
    y: 10.5,
    z: 2.0,
    vz: 0,
    radius: 0.27,
    height: 1.5,
    facing: 0,
    onGround: false,
    isMoving: false,
    walkCycle: 0,
  };

  // 入力状態
  const keys = Object.create(null);
  const drag = {
    active: false,
    lastX: 0,
    lastY: 0,
  };

  // 右パネル・単体モデルプレビュー状態
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
  const worldCanvas = document.getElementById("world-canvas");
  const worldCtx = worldCanvas.getContext("2d");
  const previewCanvas = document.getElementById("preview-canvas");
  const previewCtx = previewCanvas.getContext("2d");

  const hudPos = document.getElementById("hud-pos");
  const hudGround = document.getElementById("hud-ground");
  const hudCam = document.getElementById("hud-cam");
  const btnResetPos = document.getElementById("btn-reset-pos");
  const btnResetCam = document.getElementById("btn-reset-cam");

  const modelTabs = document.getElementById("model-tabs");
  const previewCaption = document.getElementById("preview-caption");
  const hoverLayerInfo = document.getElementById("hover-layer-info");
  const sliceGrid = document.getElementById("slice-grid");

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
  const chkPixelated = document.getElementById("chk-pixelated");
  const chkWireframe = document.getElementById("chk-wireframe");

  // カッタースライダーの上限をワールドの実高さに合わせる
  sliderCutaway.max = String(world.maxUsedSlice);
  sliderCutaway.value = String(world.maxUsedSlice);
  valCutaway.textContent = `${world.maxUsedSlice} / ${world.maxUsedSlice}`;

  // ============================================================
  // 3D ボクセル当たり判定（AABB vs ボクセルグリッド）
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

    // ワールド外周からは落ちないようにガード
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
    player.x = 10.5;
    player.y = 10.5;
    player.z = 2.0;
    player.vz = 0;
    player.facing = 0;
    player.onGround = true;
  }

  function resetCameraView() {
    camera.yaw = Math.PI / 4;
    camera.pitchDeg = 45;
    camera.zoom = 3.4;
    syncCameraUI();
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
    hudCam.textContent = `${yawDeg}° / ${pitchDeg}°`;

    document.querySelectorAll("[data-pitch]").forEach((btn) => {
      const v = parseFloat(btn.dataset.pitch);
      btn.classList.toggle("active", Math.abs(v - pitchDeg) <= 1);
    });
  }

  // ============================================================
  // プレイヤー移動・ジャンプ・重力更新
  // ============================================================
  function updatePlayer(dt) {
    // キーによるカメラ回転
    const yawSpeed = 1.7;
    if (keys["KeyQ"]) {
      camera.yaw -= yawSpeed * dt;
      syncCameraUI();
    }
    if (keys["KeyE"]) {
      camera.yaw += yawSpeed * dt;
      syncCameraUI();
    }

    // 画面の上下左右入力を取得
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

      // カメラの水平角 (yaw) に合わせてワールド空間の移動方向へ変換
      const cos = Math.cos(-camera.yaw);
      const sin = Math.sin(-camera.yaw);
      const wx = ix * cos - iy * sin;
      const wy = ix * sin + iy * cos;

      const walkSpeed = 4.6; // ブロック/秒
      const stepX = wx * walkSpeed * dt;
      const stepY = wy * walkSpeed * dt;

      // 向きをスムーズに補間
      const targetFacing = Math.atan2(wy, wx);
      let diff = targetFacing - player.facing;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      player.facing += diff * Math.min(1, dt * 14);

      // X軸・Y軸の水平移動（段差にはワープせず壁として止まり、Spaceジャンプで登る）
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

    // ジャンプ（1.25ブロック程度の高さまで跳べる）
    if (keys["Space"] && player.onGround) {
      player.vz = 7.4;
      player.onGround = false;
    }

    // 重力・垂直移動（床との境界でチラつかないよう厳密に層ごとに接地判定する）
    const gravity = 20.0;
    player.vz -= gravity * dt;
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
      // 上昇中：アーチ橋の下など天井との衝突チェック
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

    // カメラがプレイヤーを滑らかに追従
    const follow = Math.min(1, dt * 7);
    camera.x += (player.x - camera.x) * follow;
    camera.y += (player.y - camera.y) * follow;
    camera.z += (player.z - camera.z) * Math.min(1, dt * 4.5);

    // HUD 更新（文字幅がぶれて折り返さないよう簡潔な固定表現にする）
    hudPos.textContent = `${player.x.toFixed(1)}, ${player.y.toFixed(1)}, ${player.z.toFixed(1)}`;
    const floor = world.findFloorBelow(player.x, player.y, player.z + 0.05);
    hudGround.textContent = player.onGround
      ? BLOCK_NAMES[floor.blockType] || "地面"
      : "空中";
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

    const scale = model.id === "player" ? 5.6 : 5.2;
    const pitchRad = (camera.pitchDeg * Math.PI) / 180;
    const totalLift = (model.layerCount - 1) * Math.cos(pitchRad) * scale * settings.sliceSpacingMult;
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
    }, 55);
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

  // ワールドキャンバスのドラッグでカメラ自由回転＆傾き調整
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
      const factor = ev.deltaY > 0 ? 0.92 : 1.08;
      camera.zoom = Math.max(1.8, Math.min(6.0, camera.zoom * factor));
    },
    { passive: false }
  );

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
    }
  });
  window.addEventListener("keyup", (ev) => {
    keys[ev.code] = false;
  });

  function resizeWorldCanvas() {
    const parent = worldCanvas.parentElement;
    if (!parent) return;
    worldCanvas.width = Math.max(300, parent.clientWidth);
    worldCanvas.height = Math.max(300, parent.clientHeight);
  }
  window.addEventListener("resize", resizeWorldCanvas);

  // ============================================================
  // メインループ
  // ============================================================
  let lastTime = performance.now();

  function tick(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    updatePlayer(dt);

    const w = worldCanvas.width;
    const h = worldCanvas.height;
    worldCtx.clearRect(0, 0, w, h);

    camera.screenCenterX = w / 2;
    camera.screenCenterY = h / 2 + 12;

    renderVoxelWorld(worldCtx, world, player, camera, settings);
    renderPreview(dt);

    requestAnimationFrame(tick);
  }

  // 起動
  resizeWorldCanvas();
  rebuildSliceGrid();
  syncCameraUI();
  resetPlayerPosition();
  requestAnimationFrame(tick);
})(window);
