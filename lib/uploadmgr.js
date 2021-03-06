"use strict";

var ArticleEncoder = require('./article');
var util = require('./util');
var Uploader = require('./uploader');

// optional includes
var NZB, BufferPool, fs, zlib, XzCompressor;

var RE_QUOTE = /"/g;
var AR_NZB_OVR = ['subject', 'poster', 'groups', 'date'];

var trim = function(s) {
	return s.trim();
};

var reloadPost = function(post, stream, size, pool, cb) {
	if(post.data) throw new Error('Attempt to reload post that already has been loaded');
	var buf = pool ? pool.get() : (Buffer.allocUnsafe || Buffer)(size);
	stream.readRange((post.part-1) * size, buf, function(err, data) {
		if(!err) post.reloadData(data);
		if(pool) pool.put(buf);
		cb(err);
	});
};

function UploadManager(opts, cb) {
	this.opts = opts;
	this.articleSize = opts.articleSize || 768000;
	
	if(opts.nzb && opts.nzb.writeTo !== null && opts.nzb.writeTo !== undefined) {
		var outStream;
		if(typeof opts.nzb.writeTo == 'string')
			outStream = (fs || (fs = require('fs'))).createWriteStream(opts.nzb.writeTo, opts.nzb.writeOpts);
		else if(typeof opts.nzb.writeTo == 'function') {
			outStream = opts.nzb.writeTo();
			if(typeof outStream != 'object' || !outStream.writable) // assume writable stream
				throw new Error('Invalid value for nzb.writeTo');
		} else if(typeof opts.nzb.writeTo == 'object' && opts.nzb.writeTo.writable) // assume writable stream
			outStream = opts.nzb.writeTo;
		else
			throw new Error('Invalid value for nzb.writeTo');
		
		if(opts.nzb.corkOutput && outStream.cork)
			outStream.cork();
		
		switch(opts.nzb.compression) {
			case 'gzip':
				this.nzbStream = (zlib || (zlib = require('zlib'))).createGzip(opts.nzb.compressOpts);
				this.nzbStream.pipe(outStream);
			break;
			case 'deflate':
				this.nzbStream = (zlib || (zlib = require('zlib'))).createDeflateRaw(opts.nzb.compressOpts);
				this.nzbStream.pipe(outStream);
			break;
			case 'zlib':
				this.nzbStream = (zlib || (zlib = require('zlib'))).createDeflate(opts.nzb.compressOpts);
				this.nzbStream.pipe(outStream);
			break;
			case 'xz':
				this.nzbStream = new (XzCompressor || (XzCompressor = require('xz').Compressor))(opts.nzb.compressOpts.level, opts.nzb.compressOpts);
				this.nzbStream.pipe(outStream);
			break;
			default:
				this.nzbStream = outStream;
		}
		this.nzb = new (NZB || (NZB = require('./nzbbuffer')))(
			opts.nzb.metaData,
			this.nzbStream.write.bind(this.nzbStream),
			opts.nzb.minify,
			opts.nzb.writeOpts ? opts.nzb.writeOpts.encoding : ''
		);
	}
	
	this.uploader = new Uploader(opts, function(err) {
		if(this.nzb) {
			this.nzb.end(!!err);
			if(this.nzbStream !== process.stdout && this.nzbStream !== process.stderr) { // stdio cannot be closed
				this.nzbStream.on('error', function(err) {
					if(UploadManager.log) UploadManager.log.warn('Exception raised when trying to close NZB stream: ' + err);
				});
				try {
					this.nzbStream.end();
				} catch(x) {
					if(UploadManager.log) UploadManager.log.warn('Exception raised when trying to close NZB stream: ' + x);
				}
			}
		}
		// TODO: cancel reading if error
		// TODO: add ability to upload NZBs
		//  for this, the uploading section can't close the connections
		cb(err);
	}.bind(this));
	
	if(opts.useBufferPool !== false) {
		if(!BufferPool)
			BufferPool = require('./bufferpool');
		this.bufferPool = new BufferPool(ArticleEncoder.maxSize(this.articleSize, opts.bytesPerLine) + opts.headerAllocSize, BufferPool.calcSizeForUpload(this.uploader, opts.servers));
		this.reloadBufPool = new BufferPool(this.articleSize);
	}
	
	this.dateOverride = opts.postDate;
	if(this.dateOverride && !(this.dateOverride instanceof Date))
		this.dateOverride = new Date(this.dateOverride);
}
UploadManager.prototype = {
	nzb: null,
	bufferPool: null,
	reloadBufPool: null,
	dateOverride: null,
	
	addFile: function(fileName, fileSize, fileNum, fileNumTotal, postHeaders, stream, fileDone) {
		var enc = new ArticleEncoder(fileName, fileSize, this.articleSize, this.opts.bytesPerLine, this.dateOverride);
		var sizes = [];
		var self = this;
		var nzbFile;
		
		if(typeof postHeaders == 'function')
			postHeaders = postHeaders(fileName, fileSize, fileNum, fileNumTotal);
		var headers = util.extend({}, postHeaders);
		
		// default subject: pre-generate most of it - only the thing that needs customising, is the part number
		var preSubj = '';
		if(this.opts.comment) preSubj = this.opts.comment + ' ';
		if(fileNumTotal > 1) preSubj += '[' + fileNum + '/' + fileNumTotal + '] - ';
		// TODO: should we revert to single part titles if only 1 part?
		preSubj += '"' + fileName.replace(RE_QUOTE, '') + '" yEnc (';
		var postSubj = '/' + enc.parts + ') ' + fileSize + (this.opts.comment2 ? ' ' + this.opts.comment2 : '');
		
		// bind in fileNum/fileNumTotal to functions
		for(var k in headers) {
			if(typeof headers[k] == 'function') {
				headers[k] = headers[k].bind(null, fileNum, fileNumTotal);
			}
		}
		enc.setHeaders(headers, preSubj, postSubj);
		
		(function readLoop() {
			stream.read(self.articleSize, function(err, buffer) {
				if(err || !buffer.length) { // EOF / error
					return fileDone(err, {
						sizes: sizes,
						crc32: enc.crc32
					});
				}
				var postHeaders;
				if(self.nzb && !nzbFile) postHeaders = {};
				var post = enc.generate(buffer, self.bufferPool, postHeaders);
				sizes.push(post.postLen);
				post.keepMessageId = self.opts.keepMessageId;
				if(self.nzb) {
					if(!nzbFile) {
						var nzbArgs = [
							// the subject that the NZB takes is actually the subject of the first post (where counter is (1/xx))
							postHeaders.subject,
							postHeaders.from,
							postHeaders.newsgroups,
							Math.ceil(fileSize / self.articleSize),
							post.genTime
						];
						AR_NZB_OVR.forEach(function(k, i) {
							var ov = self.opts.nzb.overrides[k];
							if(i == 3) i++; // ugly hack for 'date'
							if(typeof ov == 'function') {
								ov = ov(nzbArgs[i], fileNum, fileNumTotal, fileName, fileSize, nzbArgs[3]);
							}
							if(ov !== null && ov !== undefined)
								nzbArgs[i] = ov;
						});
						// fix newsgroups/date lines
						if(!Array.isArray(nzbArgs[2]))
							nzbArgs[2] = nzbArgs[2].split(',').map(trim);
						if((typeof nzbArgs[4] != 'number') && !(nzbArgs[4] instanceof Date))
							nzbArgs[4] = new Date(nzbArgs[4]);
						nzbFile = self.nzb.file.apply(self.nzb, nzbArgs);
					}
					post.nzbSeg = nzbFile.set.bind(nzbFile, post.part-1, post.postLen);
				}
				if(stream.readRange) // reloadable post
					post.reload = reloadPost.bind(null, post, stream, self.articleSize, self.reloadBufPool);
				self.uploader.addPost(post, setImmediate.bind(null, readLoop), self.onPosted.bind(self, post));
			});
		})();
	},
	onPosted: function(post, err) {
		if(post.nzbSeg) {
			// the following will skip writing a segment if the Message-ID is invalid
			post.nzbSeg(post.messageId);
		}
		post.release();
	},
	cancel: function(reason) {
		// TODO: cancel upload
		this.uploader.cancel(reason);
	},
	finished: function() {
		this.uploader.finished();
	}
};

UploadManager.log = null;
module.exports = UploadManager;
UploadManager.setLogger = function(log) {
	UploadManager.log = log;
	Uploader.setLogger(log);
};
