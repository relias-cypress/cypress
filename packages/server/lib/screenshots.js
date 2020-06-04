/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const _               = require("lodash");
const mime            = require("mime");
const path            = require("path");
const Promise         = require("bluebird");
const dataUriToBuffer = require("data-uri-to-buffer");
const Jimp            = require("jimp");
const sizeOf          = require("image-size");
const colorString     = require("color-string");
const sanitize        = require("sanitize-filename");
let debug           = require("debug")("cypress:server:screenshot");
const plugins         = require("./plugins");
const fs              = require("./util/fs");
const glob            = require("./util/glob");
const pathHelpers     = require("./util/path_helpers");

const RUNNABLE_SEPARATOR = " -- ";
const pathSeparatorRe = /[\\\/]/g;

//# internal id incrementor
let __ID__ = null;

//# TODO: when we parallelize these builds we'll need
//# a semaphore to access the file system when we write
//# screenshots since its possible two screenshots with
//# the same name will be written to the file system

//# when debugging logs automatically prefix the
//# screenshot id to the debug logs for easier association
debug = _.wrap(debug, (fn, str, ...args) => fn(`(${__ID__}) ${str}`, ...args));

const isBlack = rgba => `${rgba.r}${rgba.g}${rgba.b}` === "000";

const isWhite = rgba => `${rgba.r}${rgba.g}${rgba.b}` === "255255255";

const intToRGBA = function(int) {
  const obj = Jimp.intToRGBA(int);

  if (debug.enabled) {
    obj.name = colorString.to.keyword([
      obj.r,
      obj.g,
      obj.b
    ]);
  }

  return obj;
};

//# when we hide the runner UI for an app or fullPage capture
//# the browser doesn't paint synchronously, it can take 100+ ms
//# to ensure that the runner UI has been hidden, we put
//# pixels in the corners of the runner UI like so:
//#
//#  -------------
//# |g w         w|  w = white
//# |w            |  g = grey
//# |             |  b = black
//# |w           b|
//#  -------------
//#
//# when taking an 'app' or 'fullPage' capture, we ensure that the pixels
//# are NOT there before accepting the screenshot
//# when taking a 'runner' capture, we ensure the pixels ARE there

const hasHelperPixels = function(image, pixelRatio) {
  const topLeft = intToRGBA(image.getPixelColor(0, 0));
  const topLeftRight = intToRGBA(image.getPixelColor(1 * pixelRatio, 0));
  const topLeftDown = intToRGBA(image.getPixelColor(0, 1 * pixelRatio));
  const bottomLeft = intToRGBA(image.getPixelColor(0, image.bitmap.height));
  const topRight = intToRGBA(image.getPixelColor(image.bitmap.width, 0));
  const bottomRight = intToRGBA(image.getPixelColor(image.bitmap.width, image.bitmap.height));

  topLeft.isNotWhite = !isWhite(topLeft);
  topLeftRight.isWhite = isWhite(topLeftRight);
  topLeftDown.isWhite = isWhite(topLeftDown);
  bottomLeft.isWhite = isWhite(bottomLeft);
  topRight.isWhite = isWhite(topRight);
  bottomRight.isBlack = isBlack(bottomRight);

  debug("helper pixels \n %O", {
    topLeft,
    topLeftRight,
    topLeftDown,
    bottomLeft,
    topRight,
    bottomRight
  });

  return (
    topLeft.isNotWhite &&
    topLeftRight.isWhite &&
    topLeftDown.isWhite &&
    bottomLeft.isWhite &&
    topRight.isWhite &&
    bottomRight.isBlack
  );
};

const captureAndCheck = function(data, automate, conditionFn) {
  let attempt;
  const start = new Date();
  let tries = 0;
  return (attempt = function() {
    tries++;
    const totalDuration = new Date() - start;
    debug("capture and check %o", { tries, totalDuration });

    const takenAt = new Date().toJSON();

    return automate(data)
    .then(function(dataUrl) {
      debug("received screenshot data from automation layer", dataUrl.slice(0, 100));

      return Jimp.read(dataUriToBuffer(dataUrl));}).then(function(image) {
      debug(`read buffer to image ${image.bitmap.width} x ${image.bitmap.height}`);

      if ((totalDuration > 1500) || conditionFn(data, image)) {
        debug("resolving with image %o", { tries, totalDuration });
        return { image, takenAt };
      } else {
        return attempt();
      }
    });
  })();
};

const isAppOnly = data => (data.capture === "viewport") || (data.capture === "fullPage");

const isMultipart = data => _.isNumber(data.current) && _.isNumber(data.total);

const crop = function(image, dimensions, pixelRatio = 1) {
  debug("dimensions before are %o", dimensions);

  dimensions = _.transform(dimensions, (result, value, dimension) => result[dimension] = value * pixelRatio);

  debug("dimensions for cropping are %o", dimensions);

  const x = Math.min(dimensions.x, image.bitmap.width - 1);
  const y = Math.min(dimensions.y, image.bitmap.height - 1);
  const width = Math.min(dimensions.width, image.bitmap.width - x);
  const height = Math.min(dimensions.height, image.bitmap.height - y);

  debug(`crop: from ${x}, ${y}`);
  debug(`        to ${width} x ${height}`);

  return image.clone().crop(x, y, width, height);
};

const pixelConditionFn = function(data, image) {
  const pixelRatio = image.bitmap.width / data.viewport.width;

  const hasPixels = hasHelperPixels(image, pixelRatio);
  const app = isAppOnly(data);

  const subject = app ? "app" : "runner";

  //# if we are app, we dont need helper pixels else we do!
  const passes = app ? !hasPixels : hasPixels;

  debug("pixelConditionFn %o", {
    pixelRatio,
    subject,
    hasPixels,
    expectedPixels: !app
  });

  return passes;
};

let multipartImages = [];

const clearMultipartState = function() {
  debug("clearing %d cached multipart images", multipartImages.length);
  return multipartImages = [];
};

const imagesMatch = (img1, img2) => //# using Buffer::equals here
img1.bitmap.data.equals(img2.bitmap.data);

const lastImagesAreDifferent = function(data, image) {
  //# ensure the previous image isn't the same,
  //# which might indicate the page has not scrolled yet
  const previous = _.last(multipartImages);
  if (!previous) {
    debug("no previous image to compare");
    return true;
  }

  const matches = imagesMatch(previous.image, image);

  debug("comparing previous and current image pixels %o", {
    previous: previous.__ID__,
    matches
  });

  //# return whether or not the two images match
  //# should be true if they don't, false if they do
  return !matches;
};

const multipartConditionFn = function(data, image) {
  if (data.current === 1) {
    return pixelConditionFn(data, image) && lastImagesAreDifferent(data, image);
  } else {
    return lastImagesAreDifferent(data, image);
  }
};

const stitchScreenshots = function(pixelRatio) {
  const fullWidth = _
  .chain(multipartImages)
  .map("data.clip.width")
  .min()
  .multiply(pixelRatio)
  .value();

  const fullHeight = _
  .chain(multipartImages)
  .sumBy("data.clip.height")
  .multiply(pixelRatio)
  .value();

  debug(`stitch ${multipartImages.length} images together`);

  const takenAts = [];
  let heightMarker = 0;
  const fullImage = new Jimp(fullWidth, fullHeight);

  _.each(multipartImages, function({ data, image, takenAt }) {
    const croppedImage = crop(image, data.clip, pixelRatio);

    debug(`stitch: add image at (0, ${heightMarker})`);

    takenAts.push(takenAt);
    fullImage.composite(croppedImage, 0, heightMarker);
    return heightMarker += croppedImage.bitmap.height;
  });

  return { image: fullImage, takenAt: takenAts };
};

const getType = function(details) {
  if (details.buffer) {
    return details.buffer.type;
  } else {
    return details.image.getMIME();
  }
};

const getBuffer = function(details) {
  if (details.buffer) {
    return Promise.resolve(details.buffer);
  } else {
    return Promise
    .promisify(details.image.getBuffer)
    .call(details.image, Jimp.AUTO);
  }
};

const getDimensions = function(details) {
  const pick = obj => _.pick(obj, "width", "height");

  if (details.buffer) {
    return pick(sizeOf(details.buffer));
  } else {
    return pick(details.image.bitmap);
  }
};

var ensureUniquePath = function(withoutExt, extension, num = 0) {
  const fullPath = num ? `${withoutExt} (${num}).${extension}` : `${withoutExt}.${extension}`;
  return fs.pathExists(fullPath)
  .then(function(found) {
    if (found) {
      return ensureUniquePath(withoutExt, extension, (num += 1));
    }
    return fullPath;
  });
};

const sanitizeToString = title => //# test titles may be values which aren't strings like
//# null or undefined - so convert before trying to sanitize
sanitize(_.toString(title));

const getPath = function(data, ext, screenshotsFolder) {
  let names;
  const specNames = (data.specName || "")
  .split(pathSeparatorRe);

  if (data.name) {
    names = data.name.split(pathSeparatorRe).map(sanitize);
  } else {
    names = _
    .chain(data.titles)
    .map(sanitizeToString)
    .join(RUNNABLE_SEPARATOR)
    .concat([])
    .value();
  }

  // truncate file names to be less than 220 characters
  // to accomodate filename size limits
  const maxFileNameLength = 220;
  const index = names.length - 1;

  if (names[index].length > maxFileNameLength) {
    names[index] = _.truncate(names[index], {
      length: maxFileNameLength,
      omission: ''
    });
  }

  //# append (failed) to the last name
  if (data.testFailure) {
    names[index] = names[index] + " (failed)";
  }

  const withoutExt = path.join(screenshotsFolder, ...specNames, ...names);

  return ensureUniquePath(withoutExt, ext);
};

const getPathToScreenshot = function(data, details, screenshotsFolder) {
  const ext = mime.getExtension(getType(details));

  return getPath(data, ext, screenshotsFolder);
};

module.exports = {
  crop,

  getPath,

  clearMultipartState,

  imagesMatch,

  copy(src, dest) {
    return fs
    .copyAsync(src, dest, {overwrite: true})
    .catch({code: "ENOENT"}, function() {});
  },
      //# dont yell about ENOENT errors

  get(screenshotsFolder) {
    //# find all files in all nested dirs
    screenshotsFolder = path.join(screenshotsFolder, "**", "*");

    return glob(screenshotsFolder, { nodir: true });
  },

  capture(data, automate) {
    __ID__ = _.uniqueId("s");

    debug("capturing screenshot %o", data);

    //# for failure screenshots, we keep it simple to avoid latency
    //# caused by jimp reading the image buffer
    if (data.simple) {
      const takenAt = new Date().toJSON();
      return automate(data)
      .then(dataUrl => ({
        takenAt,
        multipart: false,
        buffer: dataUriToBuffer(dataUrl)
      }));
    }

    const multipart = isMultipart(data);

    const conditionFn = multipart ? multipartConditionFn : pixelConditionFn;

    return captureAndCheck(data, automate, conditionFn)
    .then(function({ image, takenAt }) {
      const pixelRatio = image.bitmap.width / data.viewport.width;

      debug("pixel ratio is", pixelRatio);

      if (multipart) {
        debug(`multi-part ${data.current}/${data.total}`);
      }

      if (multipart && (data.total > 1)) {
        //# keep previous screenshot partials around b/c if two screenshots are
        //# taken in a row, the UI might not be caught up so we need something
        //# to compare the new one to
        //# only clear out once we're ready to save the first partial for the
        //# screenshot currently being taken
        if (data.current === 1) {
          clearMultipartState();
        }

        debug("storing image for future comparison", __ID__);

        multipartImages.push({ data, image, takenAt, __ID__ });

        if (data.current === data.total) {
          ({ image } = stitchScreenshots(pixelRatio));

          return { image, pixelRatio, multipart, takenAt };
        } else {
          return {};
        }
      }

      if (isAppOnly(data) || isMultipart(data)) {
        image = crop(image, data.clip, pixelRatio);
      }

      return { image, pixelRatio, multipart, takenAt };})
    .then(function({ image, pixelRatio, multipart, takenAt }) {
      if (!image) { return null; }

      if (image && data.userClip) {
        image = crop(image, data.userClip, pixelRatio);
      }

      return { image, pixelRatio, multipart, takenAt };});
  },

  save(data, details, screenshotsFolder) {
    return getPathToScreenshot(data, details, screenshotsFolder)
    .then(function(pathToScreenshot) {
      debug("save", pathToScreenshot);

      return getBuffer(details)
      .then(buffer => fs.outputFileAsync(pathToScreenshot, buffer)).then(() => fs.statAsync(pathToScreenshot).get("size")).then(function(size) {
        const dimensions = getDimensions(details);

        const { multipart, pixelRatio, takenAt } = details;

        return {
          size,
          takenAt,
          dimensions,
          multipart,
          pixelRatio,
          name: data.name,
          specName: data.specName,
          testFailure: data.testFailure,
          path: pathToScreenshot
        };});});
  },

  afterScreenshot(data, details) {
    const duration = new Date() - new Date(data.startTime);

    details = _.extend({}, data, details, { duration });
    details = _.pick(details, "size", "takenAt", "dimensions", "multipart", "pixelRatio", "name", "specName", "testFailure", "path", "scaled", "blackout", "duration");

    if (!plugins.has("after:screenshot")) {
      return Promise.resolve(details);
    }

    return plugins.execute("after:screenshot", details)
    .then(updates => {
      if (!_.isPlainObject(updates)) {
        return details;
      }

      return _.extend(details, _.pick(updates, "size", "dimensions", "path"));
    });
  }

};