import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  Alert,
  Animated,
  AppState,
  LayoutChangeEvent,
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
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

const MEDIA_PERMISSIONS = Platform.select({
  ios: [PERMISSIONS.IOS.CAMERA, PERMISSIONS.IOS.PHOTO_LIBRARY],
  android: [PERMISSIONS.ANDROID.CAMERA],
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

const TRACK_COLOR = '#F0DDE5';
const GRADIENT_COLORS = ['#E8A0BF', '#9B89E6'];
const GRADIENT_START = { x: 0, y: 0 };
const GRADIENT_END = { x: 1, y: 0 };

function ProgressBar({ progress }: { progress: number }) {
  const percent = Math.round(progress * 100);
  const animValue = useRef(new Animated.Value(0)).current;
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    // Spring rather than ease-out timing: load progress arrives irregularly and every
    // event retargets the animation mid-flight. Ease-out *starts* at peak velocity, so
    // each retarget reads as a jolt; a spring accelerates from rest and absorbs it.
    Animated.spring(animValue, {
      toValue: progress,
      useNativeDriver: true,
      stiffness: 70,
      damping: 20,
      mass: 1,
      restDisplacementThreshold: 0.001,
      restSpeedThreshold: 0.001,
    }).start();
  }, [progress, animValue]);

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
    <View style={styles.overlay}>
      <View style={styles.loadingBox}>
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
    </View>
  );
}

function App() {
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
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
      let type: unknown;
      try {
        type = JSON.parse(event.nativeEvent.data)?.type;
      } catch {
        return;
      }
      if (type !== 'REQUEST_MEDIA_ACCESS') {
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
          { text: 'Open Settings', onPress: () => openSettings().catch(() => {}) },
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
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState
          allowsInlineMediaPlayback
          contentInsetAdjustmentBehavior="never"
          onMessage={onMessage}
          onLoadProgress={e => {
            const next = e.nativeEvent.progress;
            // Ignore backwards jumps (WKWebView's estimatedProgress dips when a
            // sub-resource navigates) and sub-percent noise. Returning `prev`
            // makes React bail out, so the busy JS thread skips a whole re-render.
            setProgress(prev =>
              next <= prev || Math.round(next * 100) === Math.round(prev * 100)
                ? prev
                : next,
            );
          }}
          onLoadEnd={() => {
            setProgress(1);
            setLoaded(true);
            syncMediaAccess();
          }}
        />
      </SafeAreaView>
      {!loaded && <ProgressBar progress={progress} />}
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
