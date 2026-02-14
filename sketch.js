// ===================================
// WEBCAM MOTION PARTICLE SYSTEM
// WITH MEDIAPIPE HAND TRACKING
// ===================================
// This sketch uses webcam feed to detect hand position
// and creates a particle system that responds to movement

// Webcam variables
let video;

// Particle system
let particles = [];
const MAX_PARTICLES = 100; // Reduced for better visual clarity

// Motion detection
let motionIntensity = 0;
let motionDX = 0; // Average horizontal motion direction
let motionDY = 0; // Average vertical motion direction

// MediaPipe Hands tracking
let hands;
let indexFingerTip = null; // Stores {x, y} position of index fingertip
let handsReady = false; // Track if MediaPipe is initialized
let multiHandLandmarks = []; // Stores all detected hand landmarks

// Gesture mode
let currentMode = "none"; // "repel" | "attract" | "explosion" | "none"

// Explosion state
let explosionTriggered = false; // Prevents re-triggering every frame
let explosionMidpoint = null;   // {x, y} in canvas coords (mirrored)
let explosionTimer = 0;         // Frames remaining for outward force
const EXPLOSION_DURATION = 60;  // How many frames the force lasts

// Recovery state — tracks when a gesture just ended
let gestureRecoveryTimer = 0;
const RECOVERY_DURATION = 120;  // Frames to gently re-disperse particles
let previousMode = "none";


function setup() {
  createCanvas(640, 480);

  // Create video element for webcam 
  video = createCapture(VIDEO, () => {
    console.log('Webcam permission granted and video ready');
    // Initialize hand tracking once video is ready
    initializeHandTracking();
  });
  video.size(640, 480);
  video.hide(); // Hide the video element, we'll process it manually

  // Initialize particle array
  for (let i = 0; i < MAX_PARTICLES; i++) {
    particles.push(new Particle());
  }

  // Set initial drawing styles
  colorMode(HSB, 360, 100, 100, 100);
  noStroke();
}


async function initializeHandTracking() {
  if (typeof Hands === 'undefined') {
    console.error('MediaPipe Hands not loaded!');
    return;
  }

  console.log('Creating MediaPipe Hands instance...');

  hands = new Hands({
    locateFile: (file) => {
      return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`;
    }
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.4
  });

  hands.onResults(onHandsDetected);

  await hands.initialize();

  console.log('MediaPipe Hands configured');

  handsReady = true;

  // 🔥 IMPORTANT: warm up MediaPipe once
  await hands.send({ image: video.elt });

  console.log('MediaPipe fully initialized');

  // Start loop only AFTER warm-up completes
  processHandTracking();
}


function onHandsDetected(results) {
  // Reset fingertip position
  indexFingerTip = null;

  // Store all detected hand landmarks for gesture detection
  multiHandLandmarks = results.multiHandLandmarks || [];

  // Check if a hand was detected
  if (multiHandLandmarks.length > 0) {
    // Get the first hand
    const handLandmarks = multiHandLandmarks[0];

    // Index finger tip is landmark #8
    // Convert from normalized coordinates (0-1) to canvas coordinates
    indexFingerTip = {
      x: handLandmarks[8].x * width,
      y: handLandmarks[8].y * height
    };
  }

  // Update gesture mode each frame
  updateMode();
}


// ===================================
// GESTURE DETECTION
// ===================================

/**
 * Detect open palm: all fingertips are far from the palm center.
 * Fingertip landmarks: thumb=4, index=8, middle=12, ring=16, pinky=20
 * Palm center approximated by landmark 0 (wrist) averaged with landmark 9 (middle finger MCP).
 */
function detectOpenPalm(landmarks) {
  // Approximate palm center
  const palmX = (landmarks[0].x + landmarks[9].x) / 2;
  const palmY = (landmarks[0].y + landmarks[9].y) / 2;

  const fingertipIndices = [4, 8, 12, 16, 20];
  const threshold = 0.15; // Normalized distance threshold

  for (let i of fingertipIndices) {
    const dx = landmarks[i].x - palmX;
    const dy = landmarks[i].y - palmY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < threshold) {
      return false; // This finger is not extended
    }
  }
  return true; // All fingers are extended
}

/**
 * Detect fist: all fingertips are close to the palm center.
 */
function detectFist(landmarks) {
  // Approximate palm center
  const palmX = (landmarks[0].x + landmarks[9].x) / 2;
  const palmY = (landmarks[0].y + landmarks[9].y) / 2;

  const fingertipIndices = [4, 8, 12, 16, 20];
  const threshold = 0.12; // Normalized distance threshold (tighter than open palm)

  for (let i of fingertipIndices) {
    const dx = landmarks[i].x - palmX;
    const dy = landmarks[i].y - palmY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > threshold) {
      return false; // This finger is not curled
    }
  }
  return true; // All fingers are curled
}

/**
 * Detect two hands present.
 * Requires a minimum distance between wrists to avoid false positives
 * (e.g., MediaPipe hallucinating a second hand from a fist).
 */
function detectTwoHands() {
  if (multiHandLandmarks.length !== 2) return false;

  const wrist1 = multiHandLandmarks[0][0];
  const wrist2 = multiHandLandmarks[1][0];
  const dx = wrist1.x - wrist2.x;
  const dy = wrist1.y - wrist2.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  return dist > 0.15; // Minimum normalized distance between wrists
}

/**
 * Update currentMode based on detected gestures.
 * Priority: two hands (explosion) > open palm (repel) > fist (attract) > none.
 */
function updateMode() {
  if (detectTwoHands()) {
    currentMode = "explosion";
    // Trigger explosion only once per gesture appearance
    if (!explosionTriggered) {
      triggerExplosion();
      explosionTriggered = true;
    }
  } else {
    // Reset flag when hands separate so next two-hand gesture fires again
    explosionTriggered = false;

    if (multiHandLandmarks.length === 1) {
      const landmarks = multiHandLandmarks[0];
      if (detectOpenPalm(landmarks)) {
        currentMode = "repel";
      } else if (detectFist(landmarks)) {
        currentMode = "attract";
      } else {
        currentMode = "none";
      }
    } else {
      currentMode = "none";
    }
  }
}

/**
 * Trigger a one-shot explosion at the midpoint of the two detected hands.
 * Spawns 40 new particles at the midpoint with strong outward velocity.
 */
function triggerExplosion() {
  if (multiHandLandmarks.length < 2) return;

  const hand1 = multiHandLandmarks[0];
  const hand2 = multiHandLandmarks[1];

  // Use wrist (landmark 0) of each hand, converted to mirrored canvas coords
  let midX = width - ((hand1[0].x + hand2[0].x) / 2) * width;
  let midY = ((hand1[0].y + hand2[0].y) / 2) * height;

  explosionMidpoint = { x: midX, y: midY };
  explosionTimer = EXPLOSION_DURATION;

  // Spawn burst particles at midpoint
  const spawnCount = 40;
  for (let i = 0; i < spawnCount; i++) {
    let p = new Particle();
    p.x = midX + random(-5, 5);
    p.y = midY + random(-5, 5);

    // Strong outward velocity in random direction
    let angle = random(TWO_PI);
    let speed = random(3, 7);
    p.vx = cos(angle) * speed;
    p.vy = sin(angle) * speed;

    // Start bright and large
    p.alpha = 95;
    p.currentSize = p.baseSize * 3;
    p.targetSize = p.baseSize * 3;

    particles.push(p);
  }
}


// CONTINUOUS HAND TRACKING

async function processHandTracking() {
  // Send current video frame to MediaPipe for processing
  if (video && video.elt && handsReady) {
    try {
      await hands.send({ image: video.elt });
    } catch (error) {
      console.error('Error sending frame to MediaPipe:', error);
    }
  }

  // Continue processing on next frame
  requestAnimationFrame(processHandTracking);
}


// MAIN DRAW LOOP

function draw() {
  // Dynamic background transparency based on motion 

  let bgAlpha = map(motionIntensity, 0, 100, 50, 30); // More motion = lower alpha = longer trails
  background(0, 0, 0, bgAlpha);

  // Draw the webcam feed as a ghosted background
  push(); // Save current drawing state

  // Mirror the video horizontally
  translate(width, 0); // Move origin to right edge
  scale(-1, 1); // Flip horizontally (negative x-scale)

  // Lower opacity for subtle/ghosted effect
  tint(255, 255, 255, 60); // White tint with low alpha (60 out of 255)

  // Draw the video feed
  image(video, 0, 0, width, height);

  pop(); // Restore original drawing state

  // Only process motion if hand is detected
  if (indexFingerTip) {
    // Use hand position for motion
    calculateMotionFromHand();
  } else {
    // No hand detected, reset motion
    motionIntensity = 0;
    motionDX = 0;
    motionDY = 0;
  }

  // Update and display all particles
  for (let particle of particles) {
    particle.update(motionIntensity);
    particle.display(motionIntensity);
  }

  // Tick down explosion timer
  if (explosionTimer > 0) {
    explosionTimer--;
    if (explosionTimer <= 0) {
      explosionMidpoint = null;
    }
  }

  // Track gesture transitions for recovery re-disperse
  if (previousMode !== "none" && currentMode === "none") {
    gestureRecoveryTimer = RECOVERY_DURATION;
  }
  if (gestureRecoveryTimer > 0) gestureRecoveryTimer--;
  previousMode = currentMode;

  // --- Particle cleanup & respawn when idle ---
  if (currentMode === "none") {
    // Trim excess particles spawned by explosions
    if (particles.length > MAX_PARTICLES) {
      particles.length = MAX_PARTICLES;
    }

    // Respawn a few particles per frame at random positions to refill the screen
    let respawnCount = 2; // particles per frame
    for (let i = 0; i < Math.min(respawnCount, particles.length); i++) {
      let idx = Math.floor(random(particles.length));
      let p = particles[idx];
      // Only respawn particles that are near the edges (pushed out by repel/explosion)
      if (p.x < 20 || p.x > width - 20 || p.y < 20 || p.y > height - 20) {
        p.x = random(50, width - 50);
        p.y = random(50, height - 50);
        p.vx = random(-0.5, 0.5);
        p.vy = random(-0.5, 0.5);
      }
    }
  }

  // Draw circle at index fingertip if hand is detected
  if (indexFingerTip) {
    drawFingerIndicator();
  }

  // Display motion intensity indicator (optional debug info)
  displayDebugInfo();
}

// CALCULATE MOTION FROM HAND MOVEMENT

let prevFingerPos = null;

function calculateMotionFromHand() {
  if (!indexFingerTip) {
    motionIntensity = 0;
    motionDX = 0;
    motionDY = 0;
    return;
  }

  // If we have a previous position, calculate motion
  if (prevFingerPos) {
    // Calculate displacement
    let dx = indexFingerTip.x - prevFingerPos.x;
    let dy = indexFingerTip.y - prevFingerPos.y;

    // Calculate motion intensity based on displacement magnitude
    let displacement = sqrt(dx * dx + dy * dy);
    motionIntensity = constrain(map(displacement, 0, 20, 0, 100), 0, 100);

    // Normalize direction and INVERT dx to fix mirrored movement
    // Since the video is mirrored, we need to mirror the horizontal motion too
    if (displacement > 0.1) {
      motionDX = constrain(-dx / 10, -1, 1); // Negative to fix mirroring
      motionDY = constrain(dy / 10, -1, 1);
    }
  }

  // Store current position for next frame
  prevFingerPos = { x: indexFingerTip.x, y: indexFingerTip.y };
}


// DRAW FINGER INDICATOR

function drawFingerIndicator() {
  push();

  // Mirror the x coordinate since the video is mirrored
  let mirroredX = width - indexFingerTip.x;

  // Draw a glowing circle at the fingertip
  noStroke();

  // Outer glow
  fill(180, 80, 100, 30);
  circle(mirroredX, indexFingerTip.y, 40);

  // Middle ring
  fill(180, 80, 100, 60);
  circle(mirroredX, indexFingerTip.y, 25);

  // Inner circle
  fill(180, 80, 100, 90);
  circle(mirroredX, indexFingerTip.y, 12);

  pop();
}


// PARTICLE CLASS

class Particle {
  constructor() {
    this.reset();
  }

  reset() {
    // Random position on canvas
    this.x = random(width);
    this.y = random(height);

    // Velocity
    this.vx = random(-1, 1);
    this.vy = random(-1, 1);

    // Base properties
    this.baseSpeed = random(0.5, 2);
    this.baseSize = random(3, 8); // Base size for particles
    this.currentSize = this.baseSize;  // Current rendered size
    this.targetSize = this.baseSize;   // Size we're lerping toward
    this.hue = random(360); // Color hue
    this.alpha = 50; // Transparency
  }

  update(intensity) {
    // Motion intensity affects speed and brightness
    let speedMultiplier = map(intensity, 0, 100, 0.5, 3);

    // Apply motion direction to particle velocity
    // Particles will move in the same direction as detected motion
    let motionInfluence = 0.7; // How much motion direction affects particles
    this.vx += motionDX * motionInfluence;
    this.vy += motionDY * motionInfluence;

    // Update position based on intensity and direction
    this.x += this.vx * this.baseSpeed * speedMultiplier;
    this.y += this.vy * this.baseSpeed * speedMultiplier;

    // Update alpha (brightness) based on intensity
    this.alpha = map(intensity, 0, 100, 20, 90);

    // --- Size & brightness scaling based on gesture mode ---
    let gestureActive = (currentMode === "repel" || currentMode === "attract" || currentMode === "explosion");
    if (gestureActive) {
      this.targetSize = this.baseSize * 3;
      this.alpha = constrain(this.alpha + 5, 0, 95); // Ramp up brightness
    } else {
      this.targetSize = this.baseSize;
      this.alpha = lerp(this.alpha, map(intensity, 0, 100, 20, 90), 0.1); // Fade back
    }

    // Smoothly lerp currentSize toward targetSize
    this.currentSize = lerp(this.currentSize, this.targetSize, 0.08);

    // --- Repel force ---
    if (currentMode === "repel" && indexFingerTip) {
      // Use mirrored hand x to match the visually displayed position
      let handX = width - indexFingerTip.x;
      let handY = indexFingerTip.y;

      let dx = this.x - handX;
      let dy = this.y - handY;
      let distSq = dx * dx + dy * dy;
      let dist = Math.sqrt(distSq);

      let radius = 300; // Influence radius in pixels
      if (dist < radius && dist > 1) {
        // Force strength falls off with distance squared
        let strength = 8.0 / (1 + distSq * 0.0005);
        strength = Math.min(strength, 5.0); // Cap max force

        // Normalize direction and apply force as acceleration
        this.vx += (dx / dist) * strength;
        this.vy += (dy / dist) * strength;
      }
    }

    // --- Attract force ---
    if (currentMode === "attract" && indexFingerTip) {
      let handX = width - indexFingerTip.x;
      let handY = indexFingerTip.y;

      let dx = handX - this.x; // Direction toward hand
      let dy = handY - this.y;
      let dist = Math.sqrt(dx * dx + dy * dy);

      let radius = 300; // Influence radius in pixels
      if (dist < radius && dist > 1) {
        // Gravitational-style: stronger when closer
        let strength = 2.5 / (1 + dist * 0.02);
        strength = Math.min(strength, 1.5); // Cap for stability

        // Normalize direction and apply force as acceleration
        this.vx += (dx / dist) * strength;
        this.vy += (dy / dist) * strength;
      }
    }

    // --- Explosion force ---
    if (explosionMidpoint && explosionTimer > 0) {
      let dx = this.x - explosionMidpoint.x;
      let dy = this.y - explosionMidpoint.y;
      let dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 1) {
        // Force fades over time and with distance
        let timeFactor = explosionTimer / EXPLOSION_DURATION; // 1 → 0
        let strength = (5.0 * timeFactor) / (1 + dist * 0.01);
        strength = Math.min(strength, 4.0);

        this.vx += (dx / dist) * strength;
        this.vy += (dy / dist) * strength;
      }
    }

    // --- Recovery re-disperse force (only after a gesture just ended) ---
    if (currentMode === "none" && gestureRecoveryTimer > 0) {
      // Randomized drift to spread particles back out naturally
      let recoveryFactor = gestureRecoveryTimer / RECOVERY_DURATION;
      this.vx += random(-0.15, 0.15) * recoveryFactor;
      this.vy += random(-0.15, 0.15) * recoveryFactor;
    }

    // Add slight random movement for natural look
    this.vx += random(-0.05, 0.05);
    this.vy += random(-0.05, 0.05);

    // Apply damping to prevent endless acceleration
    this.vx *= 0.95;
    this.vy *= 0.95;

    // Limit velocity
    this.vx = constrain(this.vx, -8, 8);
    this.vy = constrain(this.vy, -8, 8);

    // Wrap around screen edges
    if (this.x < 0) this.x = width;
    if (this.x > width) this.x = 0;
    if (this.y < 0) this.y = height;
    if (this.y > height) this.y = 0;
  }

  display(intensity) {
    let gestureActive = (currentMode === "repel" || currentMode === "attract" || currentMode === "explosion");

    // Draw particle as a colored circle using smoothly interpolated size
    fill(this.hue, 70, gestureActive ? 100 : 90, this.alpha);
    circle(this.x, this.y, this.currentSize);

    // Outer glow during active gestures
    if (gestureActive) {
      fill(this.hue, 50, 100, this.alpha * 0.25);
      circle(this.x, this.y, this.currentSize * 1.8);
    }

    // Draw trail — longer and thicker during gestures
    let trailAlpha = gestureActive ? this.alpha * 0.7 : this.alpha * 0.5;
    let trailWeight = gestureActive ? 2.5 : 1.5;
    let trailLength = gestureActive ? 12 : map(intensity, 0, 100, 3, 8);

    stroke(this.hue, 70, 90, trailAlpha);
    strokeWeight(trailWeight);
    line(this.x, this.y, this.x - this.vx * trailLength, this.y - this.vy * trailLength);
    noStroke();
  }
}


// DEBUG INFO DISPLAY

function displayDebugInfo() {


  // Show hand detection status
  textSize(10);
  if (indexFingerTip) {
    fill(120, 70, 90);
    text('✓ Hand Detected', 15, 45);
  } else {
    fill(0, 0, 60);
    text('✗ No Hand Detected', 15, 45);
  }

  // Show MediaPipe status
  if (handsReady) {
    fill(120, 70, 90);
    text('✓ MediaPipe Ready', 15, 60);
  } else {
    fill(0, 70, 90);
    text('⟳ Loading MediaPipe...', 15, 60);
  }

  // Show current gesture mode
  let modeColor;
  switch (currentMode) {
    case "repel": modeColor = [180, 80, 100]; break; // Cyan
    case "attract": modeColor = [30, 80, 100]; break; // Orange
    case "explosion": modeColor = [0, 90, 100]; break; // Red
    default: modeColor = [0, 0, 60]; break; // Gray
  }
  fill(...modeColor);
  text('Mode: ' + currentMode, 15, 75);
}

