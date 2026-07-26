import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, LayoutChangeEvent, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

function GradientBar({ animatedWidth }: { animatedWidth: Animated.AnimatedInterpolation<number> }) {
  return (
    <Animated.View style={[styles.gradientWrapper, { width: animatedWidth }]}>
      <View style={[styles.gradientLayer, { backgroundColor: '#E8A0BF' }]} />
      <View
        style={[
          styles.gradientLayer,
          { backgroundColor: '#9B89E6', opacity: 0, left: 0 },
        ]}
      />
      <View
        style={[
          styles.gradientLayer,
          { backgroundColor: '#9B89E6', opacity: 0.3, left: '25%', right: 0 },
        ]}
      />
      <View
        style={[
          styles.gradientLayer,
          { backgroundColor: '#9B89E6', opacity: 0.6, left: '50%', right: 0 },
        ]}
      />
      <View
        style={[
          styles.gradientLayer,
          { backgroundColor: '#9B89E6', opacity: 1, left: '75%', right: 0 },
        ]}
      />
    </Animated.View>
  );
}

function ProgressBar({ progress }: { progress: number }) {
  const percent = Math.round(progress * 100);
  const animValue = useRef(new Animated.Value(0)).current;
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    Animated.timing(animValue, {
      toValue: progress,
      duration: 300,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [progress, animValue]);

  const animatedWidth = animValue.interpolate({
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
          {trackWidth > 0 && <GradientBar animatedWidth={animatedWidth} />}
        </View>
      </View>
    </View>
  );
}

function App() {
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
        <WebView
          source={{ uri: 'https://color-sprite-canvas.vercel.app/' }}
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState
          allowsInlineMediaPlayback
          contentInsetAdjustmentBehavior="never"
          onLoadProgress={e => setProgress(e.nativeEvent.progress)}
          onLoadEnd={() => {
            setProgress(1);
            setLoaded(true);
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
    backgroundColor: '#F0DDE5',
    overflow: 'hidden',
  },
  gradientWrapper: {
    height: 14,
    borderRadius: 7,
    overflow: 'hidden',
  },
  gradientLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    borderRadius: 7,
  },
});

export default App;
