<template>
  <div class="w-full h-full bg-black relative overflow-hidden">

    <!-- WebGL unavailable fallback (static check or runtime failure) -->
    <div v-if="!webGLAvailable || webGLRuntimeError" class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-900 text-center px-6">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p class="text-sm font-semibold text-gray-300">3D preview unavailable</p>
      <p class="text-xs text-gray-500 max-w-xs">Your browser could not create a WebGL context. Try enabling GPU acceleration or opening the app in a different browser.</p>
    </div>

    <TresCanvas v-else-if="!webGLRuntimeError" window-size :clear-color="textureType === 'none' ? '#87CEEB' : '#000000'" shadows :tone-mapping="THREE.ACESFilmicToneMapping" :tone-mapping-exposure="0.8" :renderer="{ logarithmicDepthBuffer: true }">
      <Suspense>
        <template #default>
          <TresGroup>
            <TresPerspectiveCamera
              :args="cameraArgs"
              :position="cameraPosition"
            />
            <CSMLight
              :light-direction="activeSunPreset.lightDirection"
              :cascades="4"
              :shadow-map-size="4096"
              :max-far="500"
              :light-intensity="activeSunPreset.lightIntensity"
              :ambient-intensity="activeSunPreset.ambientIntensity"
              :light-color="activeSunPreset.lightColor"
              :ambient-color="activeSunPreset.ambientColor"
              :shadow-bias="0.00045"
              :shadow-normal-bias="0.035"
              :light-margin="50"
            />

            <Environment :files="currentHdrFile" :background="true" :environment-intensity="activeSunPreset.environmentIntensity" />

            <TerrainMesh
              :terrain-data="mergedTerrainData"
              :quality="meshQuality"
              :texture-type="textureType"
              :wireframe="showWireframe"
            />

            <MapngFlag3D
              :terrain-data="mergedTerrainData"
            />

            <OSMFeatures3D
              :terrain-data="terrainData"
              :feature-visibility="featureVisibility"
            />

            <GoogleTiles3D
              :terrain-data="terrainData"
            />

            <SurroundingTerrain3D
              :terrain-data="terrainData"
              :visible="showSurroundings"
              :quality="meshQuality"
              :texture-mode="surroundingTextureType"
              @loading-state="handleSurroundingsLoadingState"
            />

            <OrbitControls
              v-if="!flyMode"
              ref="controlsRef"
              make-default
              :min-distance="1"
              :max-distance="1000"
              :min-polar-angle="0"
              :max-polar-angle="Math.PI * 0.48"
              :enable-damping="true"
              :damping-factor="0.05"
            />
            <FlyControls3D
              v-if="flyMode"
              ref="flyRef"
              :fov="flyFov"
              @refine="refineFromPose"
              @locked-change="flyLocked = $event"
            />
          </TresGroup>
        </template>
        <template #fallback>
          <TresGroup />
        </template>
      </Suspense>
    </TresCanvas>

    <!-- Fly-mode HUD -->
    <div
      v-if="flyMode"
      class="absolute top-4 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2 pointer-events-none"
    >
      <div
        v-if="!flyLocked"
        class="px-3 py-1.5 bg-black/70 backdrop-blur rounded-md text-xs text-white font-medium pointer-events-none"
      >
        {{ t('preview.flyClickToLook') }}
      </div>
      <div class="flex items-center gap-3 px-4 py-2.5 bg-black/70 backdrop-blur rounded-lg shadow-xl pointer-events-auto">
        <button
          @click="refineFromHud"
          :disabled="googleTilesStore.refining"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-[#FF6600] hover:bg-[#e65c00] disabled:bg-gray-600 disabled:cursor-wait text-white text-xs font-bold rounded-md transition-colors"
        >
          <Crosshair :size="13" />
          {{ t('preview.flyRefine') }}
        </button>
        <label class="flex items-center gap-1.5 text-[10px] text-gray-300">
          {{ t('preview.flyFov') }}
          <input type="range" min="30" max="110" step="1" v-model.number="flyFov" class="w-20 accent-[#FF6600]" />
          <span class="w-6 text-right tabular-nums">{{ flyFov }}°</span>
        </label>
        <label class="flex items-center gap-1.5 text-[10px] text-gray-300 cursor-pointer" :title="t('preview.flyAutoRefineHint')">
          <input type="checkbox" v-model="autoRefine" class="accent-[#FF6600]" />
          {{ t('preview.flyAutoRefine') }}
        </label>
        <button
          @click="flyMode = false"
          class="px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-[10px] font-medium rounded-md transition-colors"
        >
          {{ t('preview.flyExit') }}
        </button>
      </div>
      <div class="px-3 py-1 bg-black/50 backdrop-blur rounded text-[10px] text-gray-300 pointer-events-none">
        <template v-if="googleTilesStore.refining">
          <!-- stations > 1 = the one-time base re-sweep that rebuilds a dead
               worker session; a refinement sweep is always a single station -->
          {{ googleTilesStore.progress.stations > 1
            ? t('preview.flyPreparing', { station: googleTilesStore.progress.station, stations: googleTilesStore.progress.stations })
            : t('preview.flyRefining', { visible: googleTilesStore.progress.visible, inflight: googleTilesStore.progress.inflight }) }}
        </template>
        <template v-else-if="googleTilesStore.refineError">
          <span class="text-red-400">{{ googleTilesStore.refineError }}</span>
        </template>
        <template v-else>
          {{ t('preview.flyHudHint') }}
        </template>
      </div>
    </div>

    <!-- Toggle Tab -->
    <button
      @click="showSceneSettings = !showSceneSettings"
      :class="[
        'absolute top-4 z-40 bg-white/90 dark:bg-gray-800/90 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-r-lg shadow-lg transition-all duration-300 ease-in-out hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1.5 px-2 py-2',
        showSceneSettings ? 'left-64' : 'left-0'
      ]"
      :title="showSceneSettings ? t('preview.hideSettings') : t('preview.showSettings')"
    >
      <component :is="showSceneSettings ? ChevronLeft : ChevronRight" :size="14" class="text-[#FF6600]" />
      <span v-if="!showSceneSettings" class="text-xs font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">{{ t('preview.sceneSettings') }}</span>
    </button>

    <!-- Scene Controls Slide-out Panel -->
    <div
      :class="[
        'absolute top-0 left-0 z-30 bg-white/90 dark:bg-gray-900/95 backdrop-blur-md border-r border-gray-200 dark:border-gray-700 p-4 w-64 shadow-2xl transition-transform duration-300 ease-in-out h-full overflow-y-auto',
        showSceneSettings ? 'translate-x-0' : '-translate-x-full'
      ]"
    >
      <div
        class="flex items-center gap-2 text-gray-900 dark:text-white mb-3 border-b border-gray-200 dark:border-gray-700 pb-2"
      >
        <Settings :size="16" class="text-[#FF6600]" />
        <span class="text-sm font-bold">{{ t('preview.sceneSettings') }}</span>
      </div>

      <!-- Environment Selector -->
      <div class="space-y-2 mb-4">
        <label class="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
          <Settings :size="12" /> {{ t('preview.environment') }}
        </label>
        <select
          v-model="preset"
          class="w-full appearance-none bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-xs rounded py-2 px-3 focus:ring-1 focus:ring-[#FF6600] outline-none capitalize cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <option v-for="p in presets" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>

      <div class="space-y-2 mb-4">
        <label class="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
          <Settings :size="12" /> {{ t('preview.sunPositioning') }}
        </label>
        <select
          v-model="sunPosition"
          class="w-full appearance-none bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-xs rounded py-2 px-3 focus:ring-1 focus:ring-[#FF6600] outline-none cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <option v-for="s in sunPositionOptions" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>

      <!-- Overlays -->
      <div class="space-y-2">
        <label class="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
          <Layers :size="12" /> {{ t('preview.textureMode') }}
        </label>

        <div
          class="flex bg-gray-100 dark:bg-gray-800 rounded-md p-1 border border-gray-200 dark:border-gray-700 mb-2"
        >
          <button
            @click="textureType = 'satellite'"
            :class="[
              'flex-1 text-xs py-1.5 rounded transition-colors',
              textureType === 'satellite'
                ? 'bg-[#FF6600] text-white shadow-sm font-medium'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-white dark:hover:bg-gray-700',
            ]"
          >
            {{ t('preview.satellite') }}
          </button>
          <button
            @click="textureType = 'osm'"
            :disabled="!terrainData.osmTextureUrl"
            :title="
              !terrainData.osmTextureUrl
                ? t('preview.noOsmData')
                : t('preview.showOsmLayer')
            "
            :class="[
              'flex-1 text-xs py-1.5 rounded transition-colors',
              textureType === 'osm'
                ? 'bg-[#FF6600] text-white shadow-sm font-medium'
                : !terrainData.osmTextureUrl
                  ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-white dark:hover:bg-gray-700',
            ]"
          >
            {{ t('preview.osm') }}
          </button>
          <button
            @click="textureType = 'hybrid'"
            :disabled="!terrainData.hybridTextureUrl"
            :title="
              !terrainData.hybridTextureUrl
                ? t('preview.noHybridData')
                : t('preview.showHybridLayer')
            "
            :class="[
              'flex-1 text-xs py-1.5 rounded transition-colors',
              textureType === 'hybrid'
                ? 'bg-[#FF6600] text-white shadow-sm font-medium'
                : !terrainData.hybridTextureUrl
                  ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-white dark:hover:bg-gray-700',
            ]"
          >
            {{ t('preview.hybrid') }}
          </button>
          <button
            @click="textureType = 'none'"
            :class="[
              'flex-1 text-xs py-1.5 rounded transition-colors',
              textureType === 'none'
                ? 'bg-[#FF6600] text-white shadow-sm font-medium'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-white dark:hover:bg-gray-700',
            ]"
          >
            {{ t('preview.none') }}
          </button>
        </div>

        <!-- wireframe and 3D features -->
        <div class="space-y-3 pt-2">
          <div>
            <label class="text-[10px] text-gray-400 dark:text-gray-500 block mb-1">{{ t('preview.surroundingsTexture') }}</label>
            <select
              v-model="surroundingTextureType"
              class="w-full max-w-[140px] appearance-none bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-[10px] rounded py-1 px-2 focus:ring-1 focus:ring-[#FF6600] outline-none cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              <option value="satellite">{{ t('preview.satellite') }}</option>
              <option value="none">{{ t('preview.none') }}</option>
            </select>
          </div>

          <label class="flex items-center gap-2 cursor-pointer group/check">
            <div class="relative">
              <input
                type="checkbox"
                v-model="showSurroundings"
                class="peer sr-only"
              />
              <div
                class="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#FF6600]/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#FF6600]"
              ></div>
            </div>
            <span class="text-xs text-gray-700 dark:text-gray-300 group-hover/check:text-gray-900 dark:group-hover/check:text-white"
              >{{ t('preview.surroundingTerrain') }}</span
            >
          </label>
          <p v-if="showSurroundings" class="text-[10px] text-gray-400 dark:text-gray-500 ml-11 -mt-1">{{ t('preview.surroundingDesc') }}</p>
          <p
            v-if="showSurroundings && surroundingTextureType === 'satellite' && isSurroundingsLoading"
            class="text-[10px] text-gray-400 dark:text-gray-500 ml-11 -mt-1"
          >
            {{ surroundingsSatelliteProgress.completed }} of {{ surroundingsSatelliteProgress.total }} satellite images downloaded
          </p>

          <label class="flex items-center gap-2 cursor-pointer group/check">
            <div class="relative">
              <input
                type="checkbox"
                v-model="showWireframe"
                class="peer sr-only"
              />
              <div
                class="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#FF6600]/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#FF6600]"
              ></div>
            </div>
            <span class="text-xs text-gray-700 dark:text-gray-300 group-hover/check:text-gray-900 dark:group-hover/check:text-white"
              >{{ t('preview.wireframeMode') }}</span
            >
          </label>

          <div class="space-y-2">
            <label class="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1 font-medium mb-1">
              <Layers :size="12" /> {{ t('preview.features3d') }}
            </label>
            <div class="grid grid-cols-2 gap-2">
              <label v-for="(val, key) in featureVisibility" :key="key" class="flex items-center gap-2 cursor-pointer group/check">
                <div class="relative">
                  <input
                    type="checkbox"
                    v-model="featureVisibility[key]"
                    class="peer sr-only"
                  />
                  <div
                    class="w-7 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#FF6600]/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#FF6600]"
                  ></div>
                </div>
                <span class="text-[10px] capitalize text-gray-700 dark:text-gray-300 group-hover/check:text-gray-900 dark:group-hover/check:text-white font-medium select-none">
                  {{ key }}
                </span>
              </label>
            </div>
          </div>

          <!-- Google Photorealistic 3D Tiles -->
          <div class="space-y-2 pt-2">
            <label class="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1 font-medium mb-1">
              <Layers :size="12" /> {{ t('preview.googleTiles') }}
            </label>

            <p v-if="!googleTilesStore.apiKey" class="text-[10px] text-gray-400 dark:text-gray-500">
              {{ t('preview.googleTilesNoKey') }}
            </p>

            <template v-else>
              <div class="flex bg-gray-100 dark:bg-gray-800 rounded-md p-0.5 border border-gray-200 dark:border-gray-700">
                <button
                  @click="googleTilesStore.setQuality('standard')"
                  :disabled="googleTilesStore.status === 'baking'"
                  :title="t('preview.googleTilesQualityStandardHint')"
                  :class="[
                    'flex-1 text-[10px] py-1 rounded transition-colors',
                    googleTilesStore.quality === 'standard'
                      ? 'bg-[#FF6600] text-white shadow-sm font-medium'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white',
                  ]"
                >
                  {{ t('preview.googleTilesQualityStandard') }}
                </button>
                <button
                  @click="googleTilesStore.setQuality('high')"
                  :disabled="googleTilesStore.status === 'baking'"
                  :title="t('preview.googleTilesQualityHighHint')"
                  :class="[
                    'flex-1 text-[10px] py-1 rounded transition-colors',
                    googleTilesStore.quality === 'high'
                      ? 'bg-[#FF6600] text-white shadow-sm font-medium'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white',
                  ]"
                >
                  {{ t('preview.googleTilesQualityHigh') }}
                </button>
                <button
                  @click="googleTilesStore.setQuality('roads')"
                  :disabled="googleTilesStore.status === 'baking'"
                  :title="t('preview.googleTilesQualityRoadsHint')"
                  :class="[
                    'flex-1 text-[10px] py-1 rounded transition-colors',
                    googleTilesStore.quality === 'roads'
                      ? 'bg-[#FF6600] text-white shadow-sm font-medium'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white',
                  ]"
                >
                  {{ t('preview.googleTilesQualityRoads') }}
                </button>
                <button
                  @click="googleTilesStore.setQuality('max')"
                  :disabled="googleTilesStore.status === 'baking'"
                  :title="t('preview.googleTilesQualityMaxHint')"
                  :class="[
                    'flex-1 text-[10px] py-1 rounded transition-colors',
                    googleTilesStore.quality === 'max'
                      ? 'bg-[#FF6600] text-white shadow-sm font-medium'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white',
                  ]"
                >
                  {{ t('preview.googleTilesQualityMax') }}
                </button>
              </div>

              <div class="flex items-center gap-2">
                <label class="text-[10px] text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  {{ t('preview.googleTilesZOffset') }}
                </label>
                <input
                  type="range"
                  min="-50"
                  max="50"
                  step="0.5"
                  :value="googleTilesStore.zOffset"
                  @input="googleTilesStore.setZOffset($event.target.valueAsNumber)"
                  class="flex-1 accent-[#FF6600]"
                />
                <input
                  type="number"
                  step="0.5"
                  :value="googleTilesStore.zOffset"
                  @change="googleTilesStore.setZOffset($event.target.valueAsNumber)"
                  class="w-14 text-[10px] text-right tabular-nums px-1 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                />
                <span class="text-[10px] text-gray-400 dark:text-gray-500">m</span>
              </div>

              <label class="flex items-center gap-2 cursor-pointer group/check" :title="t('preview.googleTilesStripGroundHint')">
                <div class="relative">
                  <input
                    type="checkbox"
                    :checked="googleTilesStore.stripGround"
                    :disabled="googleTilesStore.status === 'baking'"
                    @change="googleTilesStore.setStripGround($event.target.checked)"
                    class="peer sr-only"
                  />
                  <div
                    class="w-7 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#FF6600]/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#FF6600]"
                  ></div>
                </div>
                <span class="text-[10px] text-gray-700 dark:text-gray-300 group-hover/check:text-gray-900 dark:group-hover/check:text-white">
                  {{ t('preview.googleTilesStripGround') }}
                </span>
              </label>

              <button
                v-if="googleTilesStore.status === 'idle' || googleTilesStore.status === 'error'"
                @click="googleTilesStore.bakeForPreview(terrainData)"
                :disabled="!terrainData"
                class="w-full flex items-center justify-center gap-2 py-1.5 bg-[#FF6600] hover:bg-[#e65c00] disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs font-bold rounded-md transition-colors"
              >
                {{ googleTilesStore.status === 'error' ? t('preview.googleTilesRetry') : t('preview.googleTilesLoad') }}
              </button>

              <p v-if="googleTilesStore.status === 'error'" class="text-[10px] text-red-500 break-words">
                {{ googleTilesStore.error }}
              </p>

              <p v-if="googleTilesStore.status === 'baking'" class="text-[10px] text-gray-400 dark:text-gray-500">
                {{ t('preview.googleTilesBaking', {
                  station: googleTilesStore.progress.station,
                  stations: googleTilesStore.progress.stations,
                  visible: googleTilesStore.progress.visible,
                  inflight: googleTilesStore.progress.inflight,
                }) }}
              </p>

              <template v-if="googleTilesStore.status === 'ready'">
                <label class="flex items-center gap-2 cursor-pointer group/check">
                  <div class="relative">
                    <input
                      type="checkbox"
                      v-model="googleTilesStore.show"
                      class="peer sr-only"
                    />
                    <div
                      class="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#FF6600]/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#FF6600]"
                    ></div>
                  </div>
                  <span class="text-xs text-gray-700 dark:text-gray-300 group-hover/check:text-gray-900 dark:group-hover/check:text-white">
                    {{ t('preview.googleTilesShow') }}
                  </span>
                </label>
                <label class="flex items-center gap-2 cursor-pointer group/check">
                  <div class="relative">
                    <input
                      type="checkbox"
                      v-model="googleTilesStore.showCameras"
                      class="peer sr-only"
                    />
                    <div
                      class="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#FF6600]/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#FF6600]"
                    ></div>
                  </div>
                  <span class="text-xs text-gray-700 dark:text-gray-300 group-hover/check:text-gray-900 dark:group-hover/check:text-white">
                    {{ t('preview.googleTilesShowCameras') }}
                  </span>
                </label>
                <p v-if="googleTilesStore.showCameras" class="text-[10px] text-gray-400 dark:text-gray-500">
                  {{ t('preview.googleTilesCamerasLegend') }}
                </p>
                <button
                  @click="flyMode = !flyMode"
                  :title="t('preview.googleTilesFlyHint')"
                  :class="[
                    'w-full flex items-center justify-center gap-2 py-1.5 text-xs font-bold rounded-md transition-colors',
                    flyMode
                      ? 'bg-gray-900 dark:bg-gray-700 hover:bg-black dark:hover:bg-gray-600 text-white'
                      : 'bg-[#FF6600] hover:bg-[#e65c00] text-white',
                  ]"
                >
                  <Plane :size="14" />
                  {{ flyMode ? t('preview.flyExit') : t('preview.googleTilesFly') }}
                </button>
                <button
                  @click="googleTilesStore.rebake(terrainData)"
                  class="text-[10px] text-gray-400 dark:text-gray-500 hover:text-[#FF6600] underline"
                >
                  {{ t('preview.googleTilesRebake') }}
                </button>
              </template>
            </template>
          </div>
        </div>

        <div class="pt-4 border-t border-gray-100 dark:border-gray-700">
          <button
            @click="resetCamera"
            class="w-full flex items-center justify-center gap-2 py-2 bg-gray-900 dark:bg-gray-700 hover:bg-black dark:hover:bg-gray-600 text-white text-xs font-bold rounded-md transition-colors shadow-lg shadow-black/10"
          >
            <RotateCcw :size="14" />
            {{ t('preview.resetCamera') }}
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, reactive, watch, onErrorCaptured, onUnmounted } from "vue";
import { useI18n } from 'vue-i18n';
import * as THREE from "three";
import { TresCanvas } from "@tresjs/core";
import { OrbitControls, Environment } from "@tresjs/cientos";
import {
  Settings,
  Layers,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Plane,
  Crosshair,
} from "lucide-vue-next";

const { t } = useI18n({ useScope: 'global' });
import TerrainMesh from "./TerrainMesh.vue";
import MapngFlag3D from "./MapngFlag3D.vue";
import OSMFeatures3D from "./OSMFeatures3D.vue";
import GoogleTiles3D from "./GoogleTiles3D.vue";
import FlyControls3D from "./FlyControls3D.vue";
import CSMLight from "./CSMLight.vue";
import SurroundingTerrain3D from "./SurroundingTerrain3D.vue";
import { useGoogleTilesStore } from "../../stores/googleTilesStore.js";
import { computeUnitsPerMeter } from "../../services/google3dTiles.js";

const props = defineProps(["terrainData"]);

const googleTilesStore = useGoogleTilesStore();

// New AOI → the baked tiles no longer match the terrain; back to idle.
// Then probe the persistent cache: if this AOI was baked before (even in a
// previous session — IndexedDB survives reloads/HMR), restore it without a
// click and without any Google refetch.
watch(() => props.terrainData, (data) => {
  if (googleTilesStore.status !== 'idle') googleTilesStore.reset();
  googleTilesStore.engaged = false; // new AOI — tiles not loaded yet here
  if (data) googleTilesStore.tryRestore(data); // a cache hit re-marks engaged
}, { immediate: true });

// Quality switch: the displayed bake no longer matches — drop it and probe
// the caches for a bake of the newly selected quality (instant when cached,
// otherwise the Load button reappears).
watch(() => googleTilesStore.quality, () => {
  if (googleTilesStore.status === 'baking') return;
  googleTilesStore.reset();
  if (props.terrainData) googleTilesStore.tryRestore(props.terrainData);
});

// Ground-strip toggle is part of the bake cache key. Restore the matching
// variant if it's cached; otherwise BAKE it — unlike the quality switch, this
// is a quick on/off comparison the user expects to SEE immediately (without it,
// flipping to an un-baked variant just leaves the OSM buildings on screen).
watch(() => googleTilesStore.stripGround, async () => {
  if (googleTilesStore.status === 'baking') return;
  // Only auto-bake the new variant if tiles were already loaded for this AOI;
  // a cold checkbox flip just probes the cache (Load button stays otherwise).
  const wasEngaged = googleTilesStore.engaged;
  googleTilesStore.reset();
  if (!props.terrainData) return;
  await googleTilesStore.tryRestore(props.terrainData);
  if (wasEngaged && googleTilesStore.status === 'idle') {
    googleTilesStore.bakeForPreview(props.terrainData);
  }
});

// Google photogrammetry replaces the OSM-extruded buildings — showing both
// just z-fights inside the photogrammetry. Auto-hide OSM buildings while the
// tiles are visible and restore the previous setting when they go away.
let buildingsBeforeTiles = null;
watch(
  () => googleTilesStore.status === 'ready' && googleTilesStore.show,
  (tilesVisible) => {
    if (tilesVisible) {
      buildingsBeforeTiles = featureVisibility.buildings;
      featureVisibility.buildings = false;
    } else if (buildingsBeforeTiles !== null) {
      featureVisibility.buildings = buildingsBeforeTiles;
      buildingsBeforeTiles = null;
    }
  },
);

const controlsRef = ref(null);

// --- Fly mode: ego-camera refinement of the Google tiles bake --------------
const flyMode = ref(false);
const flyLocked = ref(false);
const flyFov = ref(70);
const flyRef = ref(null);

// Leaving the ready state (re-bake, AOI change) ends fly mode.
watch(() => googleTilesStore.status, (s) => {
  if (s !== 'ready') flyMode.value = false;
});

/**
 * Camera pose (scene coords) → refinement station (worker wire format):
 * ENU metres from the AOI centre + heights in metres above the .ter datum.
 * The preview scene is metrically uniform at `unitsPerMeter` (X/Z native
 * scene units, Y pre-scaled), so it's a pure division; north is -Z.
 */
const refineFromPose = (pose) => {
  const data = props.terrainData;
  if (!data?.bounds || googleTilesStore.refining) return;
  const upm = computeUnitsPerMeter(data);
  const [px, py, pz] = pose.position;
  const [dx, dy, dz] = pose.direction;
  // Aim point ~60 m ahead — far enough that the frustum, not the point,
  // defines what refines.
  const aheadScene = 60 * upm;
  const lx = px + dx * aheadScene;
  const ly = py + dy * aheadScene;
  const lz = pz + dz * aheadScene;
  googleTilesStore.refineFromView(data, {
    e: px / upm,
    n: -pz / upm,
    heightM: py / upm,
    lookE: lx / upm,
    lookN: -lz / upm,
    lookHeightM: ly / upm,
    fov: pose.fov,
    aspect: pose.aspect,
  });
};

const refineFromHud = () => {
  const pose = flyRef.value?.getPose?.();
  if (pose) refineFromPose(pose);
};

// Capture mode: refine continuously from the current view while flying —
// one station every ~3 s (skipped while a refinement is still running).
const autoRefine = ref(false);
let autoRefineTimer = null;
watch([flyMode, autoRefine], ([fm, on]) => {
  if (autoRefineTimer) {
    clearInterval(autoRefineTimer);
    autoRefineTimer = null;
  }
  if (!fm) autoRefine.value = false;
  if (fm && on) {
    autoRefineTimer = setInterval(() => {
      if (!googleTilesStore.refining) refineFromHud();
    }, 3000);
  }
});
onUnmounted(() => {
  if (autoRefineTimer) clearInterval(autoRefineTimer);
});

const webGLAvailable = (() => {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    return false;
  }
})();

// Catches runtime WebGL context failures from TresCanvas (e.g. GPU memory exhausted
// at extreme resolutions). The static webGLAvailable check passes because it tests
// with a tiny canvas, but TresCanvas can still fail on the full scene context.
const webGLRuntimeError = ref(false);
onErrorCaptured((err) => {
  const msg = err?.message ?? String(err);
  if (msg.toLowerCase().includes('webgl') || msg.toLowerCase().includes('context')) {
    console.warn('[Preview3D] WebGL runtime error caught:', msg);
    webGLRuntimeError.value = true;
    return false; // stop propagation
  }
});

const hdrPresets = {
  "Kloofendal Pure Sky": "kloofendal_48d_partly_cloudy_puresky_4k.hdr",
};

const SUN_PRESETS = {
  Morning: {
    lightDirection: [-1, -0.2, -0.35],
    lightIntensity: 2.0,
    ambientIntensity: 0.08,
    environmentIntensity: 0.03,
    lightColor: '#ffcd94',
    ambientColor: '#ffead1',
  },
  "Mid Morning": {
    lightDirection: [-1, -0.45, -0.55],
    lightIntensity: 2.8,
    ambientIntensity: 0.05,
    environmentIntensity: 0.025,
    lightColor: '#ffe6bf',
    ambientColor: '#fff5e6',
  },
  Noon: {
    lightDirection: [0, -1, -0.08],
    lightIntensity: 3.5,
    ambientIntensity: 0.03,
    environmentIntensity: 0.02,
    lightColor: '#ffffff',
    ambientColor: '#f5f9ff',
  },
  Afternoon: {
    lightDirection: [0.9, -0.45, -0.45],
    lightIntensity: 2.8,
    ambientIntensity: 0.05,
    environmentIntensity: 0.022,
    lightColor: '#ffe3bf',
    ambientColor: '#fff1e0',
  },
  Evening: {
    lightDirection: [0.9, -0.22, -0.25],
    lightIntensity: 1.8,
    ambientIntensity: 0.1,
    environmentIntensity: 0.02,
    lightColor: '#ff8c4a',
    ambientColor: '#ffc79c',
  },
  Night: {
    lightDirection: [0.25, -0.08, -0.12],
    lightIntensity: 0.16,
    ambientIntensity: 0.028,
    environmentIntensity: 0.006,
    lightColor: '#86a9ff',
    ambientColor: '#9cb8ff',
  },
};

const meshQuality = 'medium';
const preset = ref("Kloofendal Pure Sky");
const sunPosition = ref("Mid Morning");
const textureType = ref("hybrid");
const surroundingTextureType = ref("none");
const showWireframe = ref(false);
const showSurroundings = ref(false);
const showSceneSettings = ref(false);
const isSurroundingsLoading = ref(false);
const surroundingsSatelliteProgress = reactive({
  completed: 0,
  total: 0,
});
const featureVisibility = reactive({
  buildings: true,
  vegetation: true,
  barriers: true,
});

const handleSurroundingsLoadingState = (state) => {
  isSurroundingsLoading.value = !!state?.isLoading;

  if (state?.textureMode !== 'satellite') {
    surroundingsSatelliteProgress.completed = 0;
    surroundingsSatelliteProgress.total = 0;
    return;
  }

  surroundingsSatelliteProgress.completed = Number(state?.completedSatellite || 0);
  surroundingsSatelliteProgress.total = Number(state?.totalSatellite || 0);
};

const mergedTerrainData = computed(() => {
  return props.terrainData;
});

const presets = Object.keys(hdrPresets);
const sunPositionOptions = Object.keys(SUN_PRESETS);
const currentHdrFile = computed(() => `/hdr/${hdrPresets[preset.value]}`);
const activeSunPreset = computed(() => SUN_PRESETS[sunPosition.value] || SUN_PRESETS.Noon);

const resetCamera = () => {
  if (controlsRef.value) {
    const controls = controlsRef.value.instance || controlsRef.value;
    // For OrbitControls, we update the camera position and the controls target
    // and then call update() if damping is enabled
    const camera = controls.object;
    if (camera) {
      camera.position.set(0, 80, 100);
      controls.target.set(0, 0, 0);
      controls.update();
    }
  }
};

// Static camera config to prevent re-renders resetting position
const cameraPosition = [0, 60, 90];
const cameraArgs = [50, 1, 0.5, 5000];
</script>
