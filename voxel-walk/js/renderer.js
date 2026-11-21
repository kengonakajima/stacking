/**
 * renderer.js
 * ------------------------------------------------------------
 * 64x64 ボクセルワールド（地形・木）＋ 半透明アニメーション水（8段階）＋ プレイヤーを
 * スプライトスタッキングで1層ずつ合成描画します。
 */
(function (global) {
  "use strict";

  const { BLOCK_SIZE, BLOCK_SLICES, PLAYER_POSES, buildWaterAnimFrames } = global.VoxelWalk;

  // 水面アニメーションフレームと合成用オフスクリーンCanvas（遅延初期化）
  let waterAnimFrames = null;
  let surfaceScratch = null;
  let surfaceScratchCtx = null;

  function ensureWaterAnimResources(world) {
    if (!waterAnimFrames) {
      waterAnimFrames = buildWaterAnimFrames(world.sizeX, world.sizeY);
      surfaceScratch = document.createElement("canvas");
      surfaceScratch.width = waterAnimFrames[0].width;
      surfaceScratch.height = waterAnimFrames[0].height;
      surfaceScratchCtx = surfaceScratch.getContext("2d");
    }
  }

  /**
   * ワールド全体＋半透明アニメーション水＋プレイヤーをスプライトスタッキングで描画する
   */
  function renderVoxelWorld(ctx, world, player, cam, settings, timeSec) {
    ensureWaterAnimResources(world);

    const pitchRad = (cam.pitchDeg * Math.PI) / 180;
    const squashY = Math.sin(pitchRad);
    const liftPerSlice = Math.cos(pitchRad) * cam.zoom * settings.sliceSpacingMult;
    const blockScreenPx = BLOCK_SIZE * cam.zoom;

    const worldSlices = world.getSlices(settings.useAO, settings.useEdgeHighlight);
    const animFrame = Math.floor(timeSec * 5.0) % waterAnimFrames.length;
    const animTex = waterAnimFrames[animFrame];

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

    // 全層表示時はプレイヤー最上部が切れないよう自動拡張
    const fullTopSlice = Math.max(world.maxUsedSlice, playerMaxSlice + 1);
    const limitZ =
      settings.maxVisibleSlice >= world.maxUsedSlice
        ? fullTopSlice
        : settings.maxVisibleSlice;

    const worldOriginX = -cam.x * blockScreenPx;
    const worldOriginY = -cam.y * blockScreenPx;
    const worldDrawW = world.canvasW * cam.zoom;
    const worldDrawH = world.canvasH * cam.zoom;

    const pRelX = (player.x - cam.x) * blockScreenPx;
    const pRelY = (player.y - cam.y) * blockScreenPx;
    const pDrawSize = 8 * cam.zoom * 0.96;

    // ワールドの土台ドロップシャドウ
    ctx.save();
    ctx.translate(
      cam.screenCenterX,
      cam.screenCenterY + cam.z * blockScreenPx * Math.cos(pitchRad) * settings.sliceSpacingMult + 14
    );
    ctx.scale(1, squashY);
    ctx.rotate(cam.yaw);
    ctx.fillStyle = "rgba(12, 28, 42, 0.24)";
    ctx.fillRect(worldOriginX + 4, worldOriginY + 4, worldDrawW, worldDrawH);
    ctx.restore();

    ctx.imageSmoothingEnabled = !settings.pixelated;

    // ============================================================
    // 【核心ループ】高さ sliceZ = 0 から 1層ずつ地形・水・プレイヤーを積み上げる
    // ============================================================
    const camBaseSlice = cam.z * BLOCK_SLICES;

    for (let sliceZ = 0; sliceZ < limitZ; sliceZ++) {
      const wSlice = sliceZ < worldSlices.length ? worldSlices[sliceZ] : null;
      const hasWaterBody = sliceZ < world.totalSlices && world.waterSliceHasBody[sliceZ] === 1;
      const hasWaterSurf = sliceZ < world.totalSlices && world.waterSliceHasSurface[sliceZ] === 1;
      const hasShadow = sliceZ === shadowSliceZ && floorInfo.floorZ > 0;
      const hasPlayer = sliceZ >= playerBaseSlice && sliceZ <= playerMaxSlice;

      // この高さに何もなければスキップ（パフォーマンス最適化）
      if (!wSlice && !hasWaterBody && !hasWaterSurf && !hasShadow && !hasPlayer) {
        continue;
      }

      const sliceOffsetY = -(sliceZ - camBaseSlice) * liftPerSlice;

      ctx.save();
      ctx.translate(cam.screenCenterX, cam.screenCenterY + sliceOffsetY);
      ctx.scale(1, squashY);
      ctx.rotate(cam.yaw);

      // 1. 固体ワールド断面（土・草・木の幹・葉）
      if (wSlice) {
        ctx.drawImage(wSlice, worldOriginX, worldOriginY, worldDrawW, worldDrawH);

        if (settings.showWireframe && sliceZ % BLOCK_SLICES === 0) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.30)";
          ctx.lineWidth = 1.2;
          ctx.strokeRect(worldOriginX, worldOriginY, worldDrawW, worldDrawH);
        }
      }

      // 2. プレイヤーの接地影
      if (hasShadow) {
        const heightAboveFloor = Math.max(0, player.z - floorInfo.floorZ);
        const shadowScale = Math.max(0.45, 1 - heightAboveFloor * 0.22);
        ctx.save();
        ctx.translate(pRelX, pRelY);
        ctx.fillStyle = `rgba(10, 20, 14, ${0.34 * shadowScale})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, pDrawSize * 0.36 * shadowScale, pDrawSize * 0.36 * shadowScale, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 3. プレイヤーの同じ高さの断面（水より先に描くことで水中では半透明の水に透けて見える！）
      if (hasPlayer) {
        const pLocalZ = sliceZ - playerBaseSlice;
        const pSliceCanvas = playerSlices[pLocalZ];
        ctx.save();
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

      // 4. 半透明の水の体積スライス（浅い水は透明感が高く、深い水は重なりで濃い青になる）
      if (hasWaterBody) {
        ctx.drawImage(world.waterBodySlices[sliceZ], worldOriginX, worldOriginY, worldDrawW, worldDrawH);
      }

      // 5. 露出水面キャップ（スクロールする波紋テクスチャアニメーションをマスク合成）
      if (hasWaterSurf) {
        const sw = surfaceScratch.width;
        const sh = surfaceScratch.height;
        surfaceScratchCtx.globalCompositeOperation = "copy";
        surfaceScratchCtx.imageSmoothingEnabled = false;
        surfaceScratchCtx.drawImage(world.waterSurfaceMasks[sliceZ], 0, 0, sw, sh);
        surfaceScratchCtx.globalCompositeOperation = "source-in";
        surfaceScratchCtx.drawImage(animTex, 0, 0);

        ctx.drawImage(surfaceScratch, worldOriginX, worldOriginY, worldDrawW, worldDrawH);
      }

      ctx.restore();
    }
  }

  /**
   * 右側観察パネル用：単体モデルのスタッキング描画
   */
  function drawSingleModelPreview(ctx, model, opts) {
    const pitchRad = (opts.pitchDeg * Math.PI) / 180;
    const squashY = Math.sin(pitchRad);
    const scale = opts.scale;
    const liftPerSlice = Math.cos(pitchRad) * scale * opts.sliceSpacingMult;

    const drawW = model.width * scale;
    const drawH = model.height * scale;

    ctx.imageSmoothingEnabled = !opts.pixelated;

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
  global.VoxelWalk.renderVoxelWorld = renderVoxelWorld;
  global.VoxelWalk.drawSingleModelPreview = drawSingleModelPreview;
})(window);
