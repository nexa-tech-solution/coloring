import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
} from 'react';
import {
  Alert,
  Animated,
  AppState,
  Easing,
  LayoutChangeEvent,
  NativeModules,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import {
  PERMISSIONS,
  RESULTS,
  check,
  openSettings,
  request,
  type Permission,
} from 'react-native-permissions';
import {
  BannerAd,
  BannerAdSize,
  TestIds,
} from 'react-native-google-mobile-ads';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

const { ImageShare } = NativeModules as {
  ImageShare?: {
    saveImage: (dataUrl: string, filename: string) => Promise<void>;
    shareImage: (dataUrl: string, filename: string) => Promise<void>;
  };
};

const MEDIA_PERMISSIONS = Platform.select({
  ios: [PERMISSIONS.IOS.CAMERA, PERMISSIONS.IOS.PHOTO_LIBRARY],
  android:
    Platform.Version <= 28
      ? [PERMISSIONS.ANDROID.CAMERA, PERMISSIONS.ANDROID.WRITE_EXTERNAL_STORAGE]
      : [PERMISSIONS.ANDROID.CAMERA],
  default: [],
});

const USABLE: string[] = [RESULTS.GRANTED, RESULTS.LIMITED];

async function statusOf(permission: Permission) {
  try {
    return await check(permission);
  } catch {
    return RESULTS.UNAVAILABLE;
  }
}

/** Can the image picker do anything useful, and if not, is Settings the only way back? */
async function readMediaAccess() {
  if (!MEDIA_PERMISSIONS.length) {
    return { ok: true, blocked: false };
  }
  const statuses = await Promise.all(MEDIA_PERMISSIONS.map(statusOf));
  const ok = statuses.some(status => USABLE.includes(status));
  return { ok, blocked: !ok && statuses.includes(RESULTS.BLOCKED) };
}

async function requestMediaPermissions() {
  // Sequential on purpose: the system shows one dialog at a time.
  for (const permission of MEDIA_PERMISSIONS) {
    try {
      // DENIED means "not asked yet, still requestable", so the prompt only
      // shows on first install. BLOCKED/GRANTED are left untouched.
      if ((await statusOf(permission)) === RESULTS.DENIED) {
        await request(permission);
      }
    } catch {
      // Never block app start on a permission failure.
    }
  }
}

// Separate AdMob apps per platform, so the banner units are separate too. A unit only
// serves under the app it was created in — crossing them over yields no fill at best.
const ANDROID_BANNER_UNIT_ID = 'ca-app-pub-3012411444875177/9216172701';
const IOS_BANNER_UNIT_ID = 'ca-app-pub-3012411444875177/2139628460';

// Never the real unit in development: debug traffic against a live ad unit is invalid
// activity, and Google suspends accounts over it.
const BANNER_AD_UNIT_ID = __DEV__
  ? TestIds.ADAPTIVE_BANNER
  : Platform.select({
      ios: IOS_BANNER_UNIT_ID,
      // `default` rather than `android`, because Platform.select without one is typed
      // string | undefined and BannerAd's unitId needs a string.
      default: ANDROID_BANNER_UNIT_ID,
    });

// The web app is a TanStack Router SPA: `/` is the page picker, `/projects/<id>` is the
// canvas. The banner belongs on the picker only — it must never sit under the drawing
// surface, where a misplaced tap on an ad is both terrible UX and an invalid click.
// Whitelist rather than blacklist, so any route added later starts ad-free by default.
const LIST_PATH = '/';

/**
 * Reports the SPA's current path to native.
 *
 * `onNavigationStateChange` is no use here: TanStack Router moves between screens with
 * history.pushState, which fires no WebView navigation event on either platform, so the
 * banner would stay stuck on whatever the first page was. Patching the history methods
 * is the only signal that catches every transition. Runs on each full page load; the
 * flag keeps a re-injection from stacking wrappers on top of the previous ones.
 */
const ROUTE_BRIDGE = `
(function () {
  if (window.__routeBridgeInstalled) { return; }
  window.__routeBridgeInstalled = true;
  var post = function () {
    window.ReactNativeWebView.postMessage(
      JSON.stringify({ type: 'ROUTE', path: window.location.pathname }),
    );
  };
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function () {
      var result = original.apply(this, arguments);
      post();
      return result;
    };
  });
  window.addEventListener('popstate', post);
  post();
})();
true;
`;

const ANDROID_NATIVE_CAPABILITIES = `
window.__nativeCapabilities = { saveImage: true, shareImage: true };
true;
`;

const TRACK_COLOR = '#F0DDE5';
const GRADIENT_COLORS = ['#E8A0BF', '#9B89E6'];
const GRADIENT_START = { x: 0, y: 0 };
const GRADIENT_END = { x: 1, y: 0 };

// Cruising speed, expressed as the time a full 0→100% sweep would take. Every move
// runs at this speed, so a retarget changes the destination without changing the pace.
const SWEEP_MS = 900;
const MIN_STEP_MS = 90;
const MAX_STEP_MS = 700;
// Once caught up to the last reported value, drift this far into the remaining
// distance...
const CREEP_FRACTION = 0.35;
// ...at a crawl, and never far enough to imply the page is nearly done.
const CREEP_MS = 2600;
const CREEP_CEILING = 0.97;
const FINISH_MAX_MS = 450;
const FADE_MS = 200;

const stepDuration = (distance: number, max: number = MAX_STEP_MS) =>
  Math.min(max, Math.max(MIN_STEP_MS, distance * SWEEP_MS));

function ProgressBar({
  progress,
  done,
  onHidden,
}: {
  progress: number;
  done: boolean;
  onHidden: () => void;
}) {
  const animValue = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const [trackWidth, setTrackWidth] = useState(0);
  const [percent, setPercent] = useState(0);
  // What the bar is showing *right now*, kept fresh by the listener below. Reading the
  // live value (rather than the last target) is what lets a retarget mid-flight measure
  // the distance it actually has left to travel.
  const shownRef = useRef(0);

  // The label is derived from the animated value, never from the incoming `progress`
  // prop. Reading the prop is what made the text claim 50% while the fill sat at 20%:
  // the prop is the animation's *destination*, and the fill was still on its way there.
  // setState is gated on the whole-percent changing, so this costs at most 100 renders
  // of a single <Text> across the entire load.
  useEffect(() => {
    const id = animValue.addListener(({ value }) => {
      shownRef.current = value;
      const next = Math.round(value * 100);
      setPercent(prev => (prev === next ? prev : next));
    });
    return () => animValue.removeListener(id);
  }, [animValue]);

  useEffect(() => {
    if (done) {
      return;
    }
    // Never travel backwards: WKWebView's estimatedProgress dips when a sub-resource
    // navigates, and the creep below can legitimately drift past the last real report.
    const target = Math.max(progress, shownRef.current);

    const animation = Animated.sequence([
      Animated.timing(animValue, {
        toValue: target,
        duration: stepDuration(target - shownRef.current),
        // Linear on purpose. Progress events arrive in bursts and each one retargets
        // this animation mid-flight. Any easing curve — or a spring, which also starts
        // from rest — drops the bar back to zero velocity on every single event:
        // decelerate, stall, re-accelerate. That stutter is the jank. Constant speed
        // has no velocity discontinuity to see.
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      Animated.timing(animValue, {
        toValue: Math.min(
          CREEP_CEILING,
          target + (1 - target) * CREEP_FRACTION,
        ),
        duration: CREEP_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);

    // WKWebView can go seconds between progress events. Without the creep the bar
    // freezes in those gaps and then lurches when the next event lands.
    animation.start();
    return () => animation.stop();
  }, [progress, done, animValue]);

  useEffect(() => {
    if (!done) {
      return;
    }
    Animated.sequence([
      Animated.timing(animValue, {
        toValue: 1,
        duration: stepDuration(1 - shownRef.current, FINISH_MAX_MS),
        // The one move that has a known endpoint, so it can afford to land softly.
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: 0,
        duration: FADE_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      // Unmounting is deferred until the fill has actually reached the end and faded.
      // Tearing the overlay down the instant loading finished used to cut the bar off
      // wherever it happened to be — the harshest jump in the whole sequence.
      if (finished) {
        onHidden();
      }
    });
  }, [done, animValue, fade, onHidden]);

  // Slide a track-coloured cover off to the right instead of growing the fill's width.
  // width is a layout prop, so it cannot use the native driver and animated on the JS
  // thread — the same thread booting the WebView. translateX runs on the UI thread.
  const coverOffset = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [0, trackWidth],
    extrapolate: 'clamp',
  });

  const onTrackLayout = (e: LayoutChangeEvent) => {
    setTrackWidth(e.nativeEvent.layout.width);
  };

  return (
    <Animated.View style={[styles.overlay, { opacity: fade }]}>
      <View
        style={styles.loadingBox}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Loading"
        accessibilityValue={{ min: 0, max: 100, now: percent }}
      >
        <Text style={styles.percentText}>{percent}%</Text>
        <View style={styles.trackContainer} onLayout={onTrackLayout}>
          <LinearGradient
            colors={GRADIENT_COLORS}
            start={GRADIENT_START}
            end={GRADIENT_END}
            style={styles.gradientFill}
          />
          <Animated.View
            style={[
              styles.trackCover,
              { transform: [{ translateX: coverOffset }] },
            ]}
          />
        </View>
      </View>
    </Animated.View>
  );
}

function App() {
  const [progress, setProgress] = useState(0);
  // Two flags, not one: `done` means the page finished loading, `hidden` means the
  // overlay has finished animating itself out. Collapsing them is what let the bar
  // vanish before it reached 100%.
  const [done, setDone] = useState(false);
  const [hidden, setHidden] = useState(false);
  const onOverlayHidden = useCallback(() => setHidden(true), []);
  // Starts null, not '/': until the page reports a route we do not know which screen is
  // showing, and guessing wrong would flash a banner onto the canvas.
  const [path, setPath] = useState<string | null>(null);
  // ComponentRef<typeof WebView>, not WebView: the library declares
  // `class WebView<P = undefined> extends Component<WebViewProps & P>`, so a bare
  // `WebView` ref collapses every prop to `never`.
  const webViewRef = useRef<ComponentRef<typeof WebView>>(null);

  // Push permission state into the page. The web app reads it synchronously in the
  // import button's click handler — awaiting there would drop the user gesture that
  // WKWebView requires to open a file picker.
  const syncMediaAccess = useCallback(async () => {
    const state = await readMediaAccess();
    webViewRef.current?.injectJavaScript(
      `window.__nativeMedia = ${JSON.stringify(state)};
       window.dispatchEvent(new Event('nativemediachange'));
       true;`,
    );
    return state;
  }, []);

  useEffect(() => {
    (async () => {
      await requestMediaPermissions();
      await syncMediaAccess();
    })();
  }, [syncMediaAccess]);

  // Returning from Settings is the whole point of the flow below, so re-read on foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        syncMediaAccess();
      }
    });
    return () => sub.remove();
  }, [syncMediaAccess]);

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      let message: {
        type?: unknown;
        path?: unknown;
        requestId?: unknown;
        filename?: unknown;
        dataUrl?: unknown;
      };
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      if (message?.type === 'ROUTE') {
        if (typeof message.path === 'string') {
          setPath(message.path);
        }
        return;
      }

      if (message?.type === 'SAVE_IMAGE' || message?.type === 'SHARE_IMAGE') {
        if (
          typeof message.requestId !== 'string' ||
          typeof message.filename !== 'string' ||
          typeof message.dataUrl !== 'string' ||
          !ImageShare
        ) {
          return;
        }

        try {
          if (message.type === 'SAVE_IMAGE') {
            await ImageShare.saveImage(message.dataUrl, message.filename);
          } else {
            await ImageShare.shareImage(message.dataUrl, message.filename);
          }
          webViewRef.current?.injectJavaScript(
            `window.__nativeSaveImageResult?.(${JSON.stringify({
              requestId: message.requestId,
              ok: true,
            })}); true;`,
          );
        } catch {
          webViewRef.current?.injectJavaScript(
            `window.__nativeSaveImageResult?.(${JSON.stringify({
              requestId: message.requestId,
              ok: false,
            })}); true;`,
          );
        }
        return;
      }

      if (message?.type !== 'REQUEST_MEDIA_ACCESS') {
        return;
      }

      // Prefer a system prompt when one is still possible; only fall back to Settings
      // once the OS has stopped asking.
      let prompted = false;
      for (const permission of MEDIA_PERMISSIONS) {
        if ((await statusOf(permission)) === RESULTS.DENIED) {
          try {
            await request(permission);
            prompted = true;
          } catch {
            // ignore and fall through to the Settings path
          }
        }
      }

      const state = await syncMediaAccess();
      if (state.ok || prompted) {
        return;
      }

      Alert.alert(
        'Allow access to your photos',
        'Coloring needs camera or photo access to add a picture. Turn it on in Settings.',
        [
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: () => openSettings().catch(() => {}),
          },
        ],
      );
    },
    [syncMediaAccess],
  );

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
        <WebView
          ref={webViewRef}
          source={{ uri: 'https://color-sprite-canvas.vercel.app/' }}
          //source={{ uri: 'http://localhost:8080' }}
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          contentInsetAdjustmentBehavior="never"
          injectedJavaScript={ROUTE_BRIDGE}
          injectedJavaScriptBeforeContentLoaded={
            Platform.OS === 'android' ? ANDROID_NATIVE_CAPABILITIES : undefined
          }
          onMessage={onMessage}
          onLoadProgress={e => {
            const next = e.nativeEvent.progress;
            // Ignore backwards jumps (WKWebView's estimatedProgress dips when a
            // sub-resource navigates) and sub-percent noise. Returning `prev`
            // makes React bail out, so the busy JS thread skips a whole re-render.
            setProgress(prev => (next > prev + 0.005 ? next : prev));
          }}
          onLoadEnd={() => {
            setDone(true);
            syncMediaAccess();
          }}
        />
        {/* Unmounted rather than hidden on the canvas: an ad that renders where nobody
            can see it still books an impression, which is exactly what AdMob's invalid
            traffic policy prohibits.

            Flush to the bottom edge, with no inset for the home indicator — the
            enclosing SafeAreaView deliberately omits the bottom edge for the same
            reason. The indicator floats over the banner's lower strip. */}
        {path === LIST_PATH && (
          <View style={styles.bannerArea}>
            <BannerAd
              unitId={BANNER_AD_UNIT_ID}
              size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
            />
          </View>
        )}
      </SafeAreaView>
      {!hidden && (
        <ProgressBar
          progress={progress}
          done={done}
          onHidden={onOverlayHidden}
        />
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  webview: {
    flex: 1,
  },
  bannerArea: {
    backgroundColor: '#ffffff',
    alignItems: 'center',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFF5F8',
  },
  loadingBox: {
    alignItems: 'center',
    width: '80%',
  },
  percentText: {
    fontSize: 28,
    fontWeight: '700',
    color: '#2D2D2D',
    marginBottom: 16,
  },
  trackContainer: {
    width: '100%',
    height: 14,
    borderRadius: 7,
    backgroundColor: TRACK_COLOR,
    overflow: 'hidden',
  },
  gradientFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  trackCover: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: TRACK_COLOR,
  },
});

export default App;
