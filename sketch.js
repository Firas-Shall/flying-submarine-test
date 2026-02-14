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
    maxNumHands: 1,
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

  // Check if a hand was detected
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    // Get the first (and only) hand
    const handLandmarks = results.multiHandLandmarks[0];

    // Index finger tip is landmark #8
    // Convert from normalized coordinates (0-1) to canvas coordinates
    indexFingerTip = {
      x: handLandmarks[8].x * width,
      y: handLandmarks[8].y * height
    };
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

    // Add slight random movement for natural look
    this.vx += random(-0.05, 0.05);
    this.vy += random(-0.05, 0.05);

    // Apply damping to prevent endless acceleration
    this.vx *= 0.95;
    this.vy *= 0.95;

    // Limit velocity
    this.vx = constrain(this.vx, -3, 3);
    this.vy = constrain(this.vy, -3, 3);

    // Wrap around screen edges
    if (this.x < 0) this.x = width;
    if (this.x > width) this.x = 0;
    if (this.y < 0) this.y = height;
    if (this.y > height) this.y = 0;
  }

  display(intensity) {
    // Size increases with motion intensity
    let currentSize = map(intensity, 0, 100, this.baseSize * 0.5, this.baseSize * 2);

    // Draw particle as a colored circle
    fill(this.hue, 70, 90, this.alpha);
    circle(this.x, this.y, currentSize);

    // Draw a longer line to show direction of movement (trail effect)
    stroke(this.hue, 70, 90, this.alpha * 0.5);
    strokeWeight(1.5);
    // Trail length increases with motion
    let trailLength = map(intensity, 0, 100, 3, 8);
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


}

