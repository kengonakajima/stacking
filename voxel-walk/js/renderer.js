/**
 * renderer.js
 * ------------------------------------------------------------
 * スプライトスタッキングによる3Dボクセルワールド描画エンジン。
 *
 * 【ポイント】
 * 1. カメラ仰角 (pitch) に合わせて水平面を縦に圧縮 (squashY = sin(pitch)) し、
 *    高さ方向へ 1スライスずつ上へずらす (lift = cos(pitch)) ことで、
 *    360°回転しても破綻しない立方体ボクセルを描画します。
 * 2. 下のスライス (z = 0) から上のスライスへ順に、
 *    世界断面 (worldSlices[z]) とプレイヤーの同じ高さの断面を交互に描きます。
 *    これにより、丘の向こうに隠れる・橋の下をくぐるといった3Dの前後関係が
 *    完全に正しく描画されます。
 */
(function (global) {
  "use strict";

  const { BLOCK_SIZE, BLOCK_SLICES, PLAYER_POSES } = global.VoxelWalk;

  /**
   * ワールド座標 (wx, wy, wz)（ブロック単位）をスクリーン座標へ投影する
   */
  function projectVoxelToScreen(wx, wy, wz, cam, settings) {
    const pitchRad = (cam.pitchDeg * Math.PI) / 180;
    const squashY = Math.sin(pitchRad);
    const liftPerBlock = Math.cos(pitchRad) * settings.sliceSpacingMult;

    const dx = wx - cam.x;
    const dy = wy - cam.y;
    const cos = Math.cos(cam.yaw);
    const sin = Math.sin(cam.yaw);

    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;

    const blockScreenPx = BLOCK_SIZE * cam.zoom;
    const dz = wz - cam.z;

    return {
      x: cam.screenCenterX + rx * blockScreenPx,
      y: cam.screenCenterY + ry * blockScreenPx * squashY - dz * blockScreenPx * liftPerBlock,
    };
  }

  /**
   * ワールド全体＋プレイヤーをスプライトスタッキングで描画する
   */
  function renderVoxelWorld(ctx, world, player, cam, settings) {
    const pitchRad = (cam.pitchDeg * Math.PI) / 180;
    const squashY = Math.sin(pitchRad);
    const liftPerSlice = Math.cos(pitchRad) * cam.zoom * settings.sliceSpacingMult;
    const blockScreenPx = BLOCK_SIZE * cam.zoom;

    const worldSlices = world.getSlices(settings.useAO, settings.useEdgeHighlight);

    // プレイヤーの現在ポーズのスライス配列を選択
    let playerSlices = PLAYER_POSES.idle;
    if (player.isMoving && player.onGround) {
      const cycle = Math.floor(player.walkCycle * 7) % 4;
      if (cycle === 1) playerSlices = PLAYER_POSES.stepA;
      else if (cycle === 3) playerSlices = PLAYER_POSES.stepB;
    } else if (!player.onGround) {
      playerSlices = PLAYER_POSES.stepA;
    }

    const playerBaseSlice = Math.round(player.z * BLOCK_SLICES);
    const playerMaxSlice = playerBaseSlice + playerSlices.length - 1;

    // 足元の影を落とすスライス高さ
    const floorInfo = world.findFloorBelow(player.x, player.y, player.z + 0.05);
    const shadowSliceZ = Math.round(floorInfo.floorZ * BLOCK_SLICES);

    // 描画する最大スライス（全層表示時は最上段のプレイヤーが切れないよう自動拡張）
    const fullTopSlice = Math.max(world.maxUsedSlice, playerMaxSlice + 1);
    const limitZ =
      settings.maxVisibleSlice >= world.maxUsedSlice
        ? fullTopSlice
        : settings.maxVisibleSlice;

    const worldOriginX = -cam.x * blockScreenPx;
    const worldOriginY = -cam.y * blockScreenPx;
    const worldDrawW = world.canvasW * cam.zoom;
    const worldDrawH = world.canvasH * cam.zoom;

    // プレイヤーのワールド座標 (cam 基準の回転前ピクセル座標)
    const pRelX = (player.x - cam.x) * blockScreenPx;
    const pRelY = (player.y - cam.y) * blockScreenPx;
    const pDrawSize = 8 * cam.zoom * 0.92;

    // ワールドの土台ドロップシャドウ（浮島感の演出）
    ctx.save();
    ctx.translate(cam.screenCenterX, cam.screenCenterY + cam.z * blockScreenPx * Math.cos(pitchRad) * settings.sliceSpacingMult + 12);
    ctx.scale(1, squashY);
    ctx.rotate(cam.yaw);
    ctx.fillStyle = "rgba(15, 32, 48, 0.22)";
    ctx.fillRect(worldOriginX + 4, worldOriginY + 4, worldDrawW, worldDrawH);
    ctx.restore();

    ctx.imageSmoothingEnabled = !settings.pixelated;

    // ============================================================
    // 【核心ループ】世界全体を高さ sliceZ = 0 から 1層ずつ積み上げる
    // ============================================================
    const camBaseSlice = cam.z * BLOCK_SLICES;

    for (let sliceZ = 0; sliceZ < limitZ; sliceZ++) {
      const sliceOffsetY = -(sliceZ - camBaseSlice) * liftPerSlice;

      // 1. ワールドの高さ sliceZ の2D断面を1枚描画
      const wSlice = sliceZ < worldSlices.length ? worldSlices[sliceZ] : null;
      if (wSlice) {
        ctx.save();
        ctx.translate(cam.screenCenterX, cam.screenCenterY + sliceOffsetY);
        ctx.scale(1, squashY);
        ctx.rotate(cam.yaw);
        ctx.drawImage(wSlice, worldOriginX, worldOriginY, worldDrawW, worldDrawH);

        // スライス枠デバッグ表示（ブロック境目ごと＝10スライスごとに枠を描く）
        if (settings.showWireframe && sliceZ % BLOCK_SLICES === 0) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
          ctx.lineWidth = 1.2;
          ctx.strokeRect(worldOriginX, worldOriginY, worldDrawW, worldDrawH);
        }
        ctx.restore();
      }

      // 2. プレイヤーの接地影（足元の床天面のすぐ上のスライスに描画）
      if (sliceZ === shadowSliceZ && floorInfo.floorZ > 0) {
        const heightAboveFloor = Math.max(0, player.z - floorInfo.floorZ);
        const shadowScale = Math.max(0.45, 1 - heightAboveFloor * 0.25);
        ctx.save();
        ctx.translate(cam.screenCenterX, cam.screenCenterY + sliceOffsetY);
        ctx.scale(1, squashY);
        ctx.rotate(cam.yaw);
        ctx.translate(pRelX, pRelY);
        ctx.fillStyle = `rgba(10, 20, 14, ${0.34 * shadowScale})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, pDrawSize * 0.36 * shadowScale, pDrawSize * 0.36 * shadowScale, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 3. プレイヤーの同じ高さ (sliceZ) の断面を差し込む
      if (sliceZ >= playerBaseSlice && sliceZ <= playerMaxSlice) {
        const pLocalZ = sliceZ - playerBaseSlice;
        const pSliceCanvas = playerSlices[pLocalZ];
        ctx.save();
        ctx.translate(cam.screenCenterX, cam.screenCenterY + sliceOffsetY);
        ctx.scale(1, squashY);
        ctx.rotate(cam.yaw);
        ctx.translate(pRelX, pRelY);
        ctx.rotate(player.facing);
        ctx.drawImage(pSliceCanvas, -pDrawSize / 2, -pDrawSize / 2, pDrawSize, pDrawSize);

        if (settings.showWireframe && pLocalZ % 3 === 0) {
          ctx.strokeStyle = "rgba(251, 191, 36, 0.7)";
          ctx.lineWidth = 1;
          ctx.strokeRect(-pDrawSize / 2, -pDrawSize / 2, pDrawSize, pDrawSize);
        }
        ctx.restore();
      }
    }
  }

  /**
   * 右側観察パネル用：単体モデル（草ブロック・土ブロック・プレイヤー）のスタッキング描画
   */
  function drawSingleModelPreview(ctx, model, opts) {
    const pitchRad = (opts.pitchDeg * Math.PI) / 180;
    const squashY = Math.sin(pitchRad);
    const scale = opts.scale;
    const liftPerSlice = Math.cos(pitchRad) * scale * opts.sliceSpacingMult;

    const drawW = model.width * scale;
    const drawH = model.height * scale;

    ctx.imageSmoothingEnabled = !opts.pixelated;

    // 接地影
    ctx.save();
    ctx.translate(opts.x, opts.y + 4);
    ctx.scale(1, squashY);
    ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
    ctx.beginPath();
    ctx.ellipse(0, 0, drawW * 0.55, drawH * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    for (let z = 0; z < model.layerCount; z++) {
      const sy = opts.y - z * liftPerSlice;
      ctx.save();
      ctx.translate(opts.x, sy);
      ctx.scale(1, squashY);
      ctx.rotate(opts.angle);

      const hasHl = opts.highlightLayer !== null && opts.highlightLayer !== undefined;
      if (hasHl && z !== opts.highlightLayer) {
        ctx.globalAlpha = 0.22;
      }

      ctx.drawImage(model.canvases[z], -drawW / 2, -drawH / 2, drawW, drawH);

      if (opts.showWireframe || (hasHl && z === opts.highlightLayer)) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = hasHl && z === opts.highlightLayer ? "#fbbf24" : "rgba(255,255,255,0.28)";
        ctx.lineWidth = hasHl && z === opts.highlightLayer ? 1.8 : 1;
        ctx.strokeRect(-drawW / 2, -drawH / 2, drawW, drawH);
      }

      ctx.restore();
    }
  }

  global.VoxelWalk = global.VoxelWalk || {};
  global.VoxelWalk.projectVoxelToScreen = projectVoxelToScreen;
  global.VoxelWalk.renderVoxelWorld = renderVoxelWorld;
  global.VoxelWalk.drawSingleModelPreview = drawSingleModelPreview;
})(window);
