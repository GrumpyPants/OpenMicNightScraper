var express = require('express');
var fs = require('fs');
var request = require('request-promise');
var cheerio = require('cheerio');
var pgp = require('pg-promise');
var Promise = require('bluebird');
var moment = require('moment');
var app     = express();
var http = require('http');
var https = require('https');

http.globalAgent.maxSockets = 1;
https.globalAgent.maxSockets = 1;

var connectionString = {
    host: 'localhost', // server name or IP address;
    port: 5432,
    database: 'openmicnight',
    user: 'openmicer',
    //password: 'user_password'
};
var db = pgp(connectionString);
var db = db(connectionString);
app.get('/scrape', function(req, res){
    var options = {
        uri: 'http://www.badslava.com/',
        timeout: 600000
    };

    request(options).then(function(html){
        var $ = cheerio.load(html);
        var blockQuoteLinks = $('blockquote a');
        var promiseArray = [];
        blockQuoteLinks.each(function(i, elem){
            var cityHref = 'http://www.badslava.com/' + $(this).attr('href');
            var typeParamIndex = cityHref.indexOf("&type=");
            cityHref = cityHref.slice(0, typeParamIndex);
            //TODO need to go to each page with type filter = comedy, music, and poety before doing this
            // If the openmic already exists then we just need to update the other type fields
            insertOpenMicsFromCityPage(cityHref, 'comedy').then(function(){
                insertOpenMicsFromCityPage(cityHref, 'music').then(function(){
                    insertOpenMicsFromCityPage(cityHref, 'poetry');
                }).catch(function (error) {
                    console.log(error); // display the error;
                });

            });
        });
    }).catch(function (error) {
        console.log(error); // display the error;
    });
});

function getWeekdayFromElem($, elem) {
    var weekDayOpenMicColumn = elem.parent.parent.parent.parent;
    //TODO calculate weekday by finding how many sibling until the end
    var columnsUntilTheEnd = 0;
    while (weekDayOpenMicColumn){
        weekDayOpenMicColumn = weekDayOpenMicColumn.next;
        columnsUntilTheEnd++;
    }
    columnsUntilTheEnd = columnsUntilTheEnd - 3;
    var weekDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].reverse();
    return weekDays[columnsUntilTheEnd];
}

function getOpenMicRegularity(openMicElement) {

    if (openMicElement.data) {
        switch (openMicElement.data) {
            case 'Bi-weekly mic':
            case 'Bi-weekly event':
                return 'biweekly';
                break;
            case 'Weekly event':
            case 'Weekly mic':
                return 'weekly';
                break;
            case '#Red\n':
            case 'Monthly mic':
                return 'monthly';
                break;
            default:
                console.warn('Unrecognized openmic regularity property found: ' + openMicElement.data);
        }
    }
    else{
        return "monthly";
    }
}

function handleSignUpSiteOrEmail($, anchor, openMicDetail) {
    var hrefAttribute = $(anchor).attr('href');
    if (hrefAttribute.startsWith("mailto:")) {
        openMicDetail.openmicContactEmail = hrefAttribute.slice(7);
    }
    else{
        openMicDetail.signUpSite = hrefAttribute;
    }
}

function handleInfoWithNotesSection($, openmicElements, openMicDetail) {
    var notesAnchor = openmicElements[6];
    var onClickAttribute = $(notesAnchor).attr('onclick');
    var endOfAlertIndex = onClickAttribute.indexOf("'); return false;");
    openMicDetail.notes = onClickAttribute.slice(7, endOfAlertIndex);

    openMicDetail.isFree = openmicElements[7].data === "Free mic";

    openMicDetail.openMicRegularity = getOpenMicRegularity(openmicElements[8]);

    if (openmicElements[9].name === 'a'){
        handleSignUpSiteOrEmail($, openmicElements[9], openMicDetail);
        openMicDetail.phoneNumber = openmicElements[10].data === 'No phone calls' ? '' : openmicElements[10].data;
    }
    else{
        openMicDetail.phoneNumber = openmicElements[9].data === 'No phone calls' ? '' : openmicElements[9].data;
    }
}

function handleInfoWithoutNotesSection($, openmicElements, openMicDetail) {
    openMicDetail.isFree = openmicElements[6].data === "Free Mic";

    openMicDetail.openMicRegularity = getOpenMicRegularity(openmicElements[7]);

    if (openmicElements[8].name === 'a'){
        handleSignUpSiteOrEmail($, openmicElements[8], openMicDetail);
        openMicDetail.phoneNumber = openmicElements[9].data === 'No phone calls' ? '' : openmicElements[9].data;
    }
    else{
        openMicDetail.phoneNumber = openmicElements[8].data === 'No phone calls' ? '' : openmicElements[8].data;
    }
}

function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

function getNextOpenMicDate(weekday, regularity) {
    var now = moment();
    var weekDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    var todayWeekDayIndex = now.weekday();
    var openMicWeekDayIndex = weekDays.indexOf(weekday);
    var dateOfOpenMic;
    var delta;
    if (openMicWeekDayIndex < todayWeekDayIndex) {
        delta = todayWeekDayIndex - openMicWeekDayIndex;
        dateOfOpenMic = now.subtract(delta, 'days');
        switch (regularity){
            case 'weekly':
                dateOfOpenMic.add(1, 'w');
                break;
            case 'monthly':
                dateOfOpenMic.add(1, 'M');
                break;
            case 'biweekly':
                dateOfOpenMic.add(2, 'w');
                break;
            default:
                console.warn('unrecognized regularity');
        }
    }
    else if (todayWeekDayIndex < openMicWeekDayIndex){
        delta = openMicWeekDayIndex - todayWeekDayIndex;
        dateOfOpenMic = now.add(delta, 'days');
    }
    else{
        dateOfOpenMic = now;
    }

    return dateOfOpenMic.startOf('day');
}

function stripOutNonTimeString(timeString) {
    if (timeString.indexOf('sign-up') !== -1) {
        timeString = timeString.slice(0, timeString.indexOf('sign-up')).trim();
    }
    else {
        timeString = timeString.slice(0, timeString.indexOf('start')).trim();
    }

    return timeString;
}

function insertOpenMicsFromCityPage(cityUrl, type) {
    var _this = this;
    var insertStatement = 'insert into openmic(openmic_name, openmic_weekday, openmic_regularity, comedian, poet, ' +
        'musician, contact_email_address, contact_phone_number, venue_name, venue_address, state, city, sign_up_time, ' +
        'start_time, is_free, next_openmic_date, notes, website) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,' +
        ' $15, $16, $17, $18)';

    var updateComedianStatement = 'update openmic set comedian=true where venue_name=$1 and venue_address=$2';
    var updateMusicianStatement = 'update openmic set musician=true where venue_name=$1 and venue_address=$2';
    var updatePoetStatement = 'update openmic set poet=true where venue_name=$1 and venue_address=$2';

    var options = {
        uri: cityUrl + '&type=' + type,
        timeout: 600000
    };
    return request(options).then(function(html) {
        var $ = cheerio.load(html);

        $('b').each(function(i, elem){
                if (elem.parent) {
                    var openmicElements = elem.parent.children;
                    var weekday = getWeekdayFromElem($, elem);
                    openmicElements = openmicElements.filter(function (obj) {
                        return obj.name !== 'br';
                    });

                    var nameText = openmicElements[0].children[0].children[0].data;
                    var nameVenueObject = getNameAndVenueFromBoldElement(nameText);

                    var streetAddress = openmicElements[1].data;
                    var selectQueryOpenMicName = nameVenueObject.openmicName ? nameVenueObject.openmicName :
                                                                               capitalizeFirstLetter(weekday) + ' Open Mic';
                    var selectQueryValues = [selectQueryOpenMicName, nameVenueObject.venueName, streetAddress, weekday];
                    db.oneOrNone("select * from openmic where openmic_name=$1 and venue_name=$2 and venue_address=$3 and openmic_weekday=$4", selectQueryValues)
                        .then(function (data) {
                            if (data) {
                                var updateStatement;
                                if (type === "comedy") {
                                    updateStatement = updateComedianStatement;
                                }
                                else if(type === "music") {
                                    updateStatement = updateMusicianStatement
                                }
                                else{
                                    updateStatement = updatePoetStatement
                                }
//\                                console.log("Attempting to update open mic (" + datype);
                                db.none(updateStatement, [nameVenueObject.venueName, streetAddress]).catch(function (error) {
                                    console.log(error);
                                });
                            }
                            else {

                                var commaIndex = openmicElements[2].data.indexOf(',');
                                var city = openmicElements[2].data.slice(0, commaIndex);

                                var state = openmicElements[2].data.slice(commaIndex + 1, openmicElements[2].length);

                                var signUpTime = stripOutNonTimeString(openmicElements[4].data);
                                var startTime = stripOutNonTimeString(openmicElements[5].data);

                                var openMicDetail = {};
                                if (openmicElements[6].name === 'a') {
                                    handleInfoWithNotesSection($, openmicElements, openMicDetail);
                                }
                                else if (openmicElements[6].data.indexOf('end')) {
                                    return;
                                }
                                else {
                                    handleInfoWithoutNotesSection($, openmicElements, openMicDetail);
                                }

                                var isComedianAllowed = false;
                                var isPoetryAllowed = false;
                                var isMusicianAllowed = false;

                                if (type === 'comedy') {
                                    isComedianAllowed = true;
                                }
                                else if (type === 'music') {
                                    isMusicianAllowed = true;
                                }
                                else if (type === 'poetry') {
                                    isPoetryAllowed = true;
                                }

                                //console.log(cityUrl + '&type=' + type);
                                //console.log("open mic name: " + nameVenueObject.openmicName);
                                var nextOpenMicDate = getNextOpenMicDate(weekday, openMicDetail.openMicRegularity);

                                //var openMicNameValue = nameVenueObject.openmicName ? nameVenueObject.openmicName : 'Open Mic';

                                var openMicNameValue = nameVenueObject.openmicName ? nameVenueObject.openmicName :
                                                                                     capitalizeFirstLetter(weekday) + ' Open Mic';
                                var values = [openMicNameValue, weekday, openMicDetail.openMicRegularity, isComedianAllowed, isPoetryAllowed,
                                    isMusicianAllowed, openMicDetail.openmicContactEmail, openMicDetail.phoneNumber,
                                    nameVenueObject.venueName, streetAddress, state, city, signUpTime, startTime,
                                    openMicDetail.isFree, nextOpenMicDate, openMicDetail.notes, openMicDetail.signUpSite];

                                return db.none(insertStatement, values);
                            }
                        }).catch(function (error) {
                        console.log(error); // display the error;
                    });
                }
        });
    }).catch(function(error){
        console.log(error);
    });
}

function getNameAndVenueFromBoldElement(nameText) {
    var delimiterIndex =  nameText.indexOf(' at ');
    if (delimiterIndex !== -1) {
        return {
            'openmicName': nameText.slice(0, delimiterIndex),
            'venueName': nameText.slice(delimiterIndex + 4, nameText.length)
        };
    }
    else{
        return {'openmicName': null, 'venueName': nameText}
    }
}

app.listen('8081')
console.log('Magic happens on port 8081');
exports = module.exports = app;