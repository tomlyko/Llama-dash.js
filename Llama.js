/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

var LlamaABR;

function LlamaABRClass() {

    let factory = dashjs.FactoryMaker;
    let SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
    let DashMetrics = factory.getSingletonFactoryByName('DashMetrics');
    let context = this.context;

    const THROUGHPUT_SAFETY_FACTOR = 1;
    const HARMONIC_MEAN_SIZE = 10;
    const MIN_BUFFER_LEVEL = -1;

    let instance,
        logger;

    function setup() {
    }

    function getMaxIndex(rulesContext) {
        const switchRequest = SwitchRequest(context).create();
        switchRequest.reason = {rule: "LlamaABR"};

        if (!rulesContext || !rulesContext.hasOwnProperty('getMediaInfo') || !rulesContext.hasOwnProperty('getMediaType') ||
            !rulesContext.hasOwnProperty('getAbrController') || !rulesContext.hasOwnProperty('getScheduleController')) {
            switchRequest.reason = {rule: "LlamaABR", explanation: "No ruleContext, Location 1"}; 
            return switchRequest;
        }

        let dashMetrics = DashMetrics(context).getInstance();
        if (!dashMetrics) {
            throw new Error('Missing config parameter(s)');
        }

        const mediaInfo = rulesContext.getMediaInfo();
        const mediaType = rulesContext.getMediaType();
        const scheduleController = rulesContext.getScheduleController();
        const abrController = rulesContext.getAbrController();
        const streamInfo = rulesContext.getStreamInfo();

        const bufferState = dashMetrics.getCurrentBufferState(mediaType);
        const isDynamic = streamInfo && streamInfo.manifestInfo ? streamInfo.manifestInfo.isDynamic : null;

        const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType, true);

        if (mediaType === 'audio') {
            return switchRequest;
        }

        if (!bufferState) {
            switchRequest.quality = 0;
            switchRequest.reason = {rule: "LlamaABR", explanation: "No buffer state."};
            return switchRequest;
        }

        let requestHistory = dashMetrics.getHttpRequests(mediaType);
        if (requestHistory.length < 5) {
            switchRequest.quality = 0;
            switchRequest.reason = {rule: "LlamaABR", explanation: "Start-up phase."};
            return switchRequest;
        }

        let harmonicMean = 0;
        let sampleSize = 0;
        for (let i = requestHistory.length-1; i >= 0; --i) {

            if (requestHistory[i].type == 'MediaSegment' && requestHistory[i]._tfinish && requestHistory[i].trequest && requestHistory[i].tresponse && requestHistory[i].trace && requestHistory[i].trace.length > 0) {

                let throughputMeasureTime = requestHistory[i].trace.reduce((a, b) => a + b.d, 0);
                let downloadBytes = requestHistory[i].trace.reduce((a, b) => a + b.b[0], 0);
                let throughput = Math.round((8 * downloadBytes) / throughputMeasureTime);

                harmonicMean = harmonicMean + (1/throughput);
                sampleSize = sampleSize + 1;

                if(sampleSize >= HARMONIC_MEAN_SIZE) {
                    break;
                }

            }

        }
        harmonicMean = 1/(harmonicMean/sampleSize);
        harmonicMean = harmonicMean*THROUGHPUT_SAFETY_FACTOR;

        let throughputMeasureTime = dashMetrics.getCurrentHttpRequest(mediaType).trace.reduce((a, b) => a + b.d, 0);
        let downloadBytes = dashMetrics.getCurrentHttpRequest(mediaType).trace.reduce((a, b) => a + b.b[0], 0);
        let lastThroughput = Math.round((8 * downloadBytes) / throughputMeasureTime);
        lastThroughput = lastThroughput*THROUGHPUT_SAFETY_FACTOR;

        let bitrates = mediaInfo.bitrateList.map(b => b.bandwidth/1000);
        let bitrateCount = bitrates.length;
        
        let currentQuality = abrController.getQualityFor(mediaType, streamInfo);
        let higherQuality = currentQuality+1;
        if(higherQuality >= bitrateCount) { higherQuality = bitrateCount-1; }
        let lowerQuality = currentQuality-1;
        if(lowerQuality < 0) { lowerQuality = 0; }

        scheduleController.setTimeToLoadDelay(0);

        if(lastThroughput < bitrates[currentQuality]) {

            //switch down
            switchRequest.quality = lowerQuality;
            switchRequest.reason = {bitrate: lastThroughput, rule: "LlamaABR", quality: switchRequest.quality};

        }
        else if(harmonicMean > bitrates[higherQuality] && lastThroughput > bitrates[higherQuality] && bufferLevel >= MIN_BUFFER_LEVEL) {

            //switch up
            switchRequest.quality = higherQuality;
            switchRequest.reason = {bitrate: harmonicMean, rule: "LlamaABR", quality: switchRequest.quality};

        }
        else {

            //stay the same
            switchRequest.quality = currentQuality;
            switchRequest.reason = {bitrate: harmonicMean, rule: "LlamaABR", quality: switchRequest.quality};

        }

        return switchRequest;
    }

    function reset() {
    }

    instance = {
        getMaxIndex: getMaxIndex,
        reset: reset
    };

    setup();

    return instance;
}

LlamaABRClass.__dashjs_factory_name = 'LlamaABR';
LlamaABR = dashjs.FactoryMaker.getClassFactory(LlamaABRClass);