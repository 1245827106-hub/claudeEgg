const { screen } = require('electron');

/**
 * Detect Windows taskbar position and dimensions
 */
function getTaskbarInfo() {
  const display = screen.getPrimaryDisplay();
  const { bounds, workArea } = display;
  const scaleFactor = display.scaleFactor || 1;

  let position = 'bottom';
  let x = workArea.x;
  let y = workArea.y + workArea.height;
  let width = bounds.width;
  let height = bounds.height - workArea.height;

  // Detect taskbar position
  if (workArea.y > bounds.y) {
    // Taskbar is at top
    position = 'top';
    y = bounds.y;
    height = workArea.y - bounds.y;
  } else if (workArea.x > bounds.x) {
    // Taskbar is on the left
    position = 'left';
    x = bounds.x;
    width = workArea.x - bounds.x;
    height = bounds.height;
    y = bounds.y;
  } else if (workArea.width < bounds.width) {
    // Taskbar is on the right
    position = 'right';
    x = workArea.x + workArea.width;
    width = bounds.width - workArea.width;
    height = bounds.height;
    y = bounds.y;
  } else {
    // Taskbar at bottom (default)
    height = bounds.height - workArea.height - (workArea.y - bounds.y);
  }

  return {
    position,
    x,
    y,
    width,
    height,
    workArea,
    bounds,
    scaleFactor
  };
}

/**
 * Get the Y position for characters walking above the taskbar
 */
function getCharacterWalkArea() {
  const info = getTaskbarInfo();
  const display = screen.getPrimaryDisplay();

  if (info.position === 'bottom') {
    return {
      walkY: info.workArea.y + info.workArea.height, // foot-level Y (taskbar top edge)
      walkXStart: info.workArea.x + 50,
      walkXEnd: info.workArea.x + info.workArea.width - 50,
      walkWidth: info.workArea.width - 100,
    };
  }

  // For top/left/right taskbar, walk at screen bottom
  return {
    walkY: display.bounds.y + display.bounds.height - info.height,
    walkXStart: info.workArea.x + 50,
    walkXEnd: info.workArea.x + info.workArea.width - 50,
    walkWidth: info.workArea.width - 100,
  };
}

module.exports = { getTaskbarInfo, getCharacterWalkArea };
