'use strict';

/**
 * Typo is a JavaScript implementation of a spellchecker using hunspell-style dictionaries.
 */

/**
 * Typo constructor.
 *
 * @param {String} [language] The locale code of the dictionary being used. e.g., "en_US". This is only used to auto-load dictionaries.
 * @param {String} [affixData] The data from the dictionary's .aff file. If omitted and Typo.js is being used in a Chrome extension, the .aff
 * 	file will be loaded automatically from lib/typo/dictionaries/[dictionary]/[dictionary].aff
 * 	In other environments, it will be loaded from [settings.dictionaryPath]/dictionaries/[dictionary]/[dictionary].aff
 * @param {String} [dictionaryData]	The data from the dictionary's .dic file. If omitted and Typo.js is being used in a Chrome extension, the .dic
 * 	file will be loaded automatically from lib/typo/dictionaries/[dictionary]/[dictionary].dic
 * 	In other environments, it will be loaded from [settings.dictionaryPath]/dictionaries/[dictionary]/[dictionary].dic
 * @param {Object} [settings]	Constructor settings. Available properties are:
 * 	{String} [dictionaryPath]: path to load dictionary from in non-chrome environment.
 * 	{Object} [flags]: flag information.
 * @returns {Typo} A Typo object.
 *
 * @see <a href="https://github.com/cfinke/Typo.js">Type</a>
 */
var Typo = function (language, affixData, dictionaryData, settings){
	settings = settings || {};

	this.language = null;

	this.rules = {};
	this.dictionaryTable = {};

	this.compoundRules = [];
	this.compoundRuleCodes = {};

	this.replacementTable = [];

	this.flags = settings.flags || {}; 

	this.memoized = {};

	this.loaded = false;


	if(language){
		this.language = language;

		if('chrome' in window && 'extension' in window.chrome && 'getURL' in window.chrome.extension){
			if(!affixData)
				affixData = this.readFile(chrome.extension.getURL('lib/typo/dictionaries/' + language + '/' + language + '.aff'));
			if(!dictionaryData)
				dictionaryData = this.readFile(chrome.extension.getURL('lib/typo/dictionaries/' + language + '/' + language + '.dic'));
		}
		else{
			var path = settings.dictionaryPath || '';
			if(!affixData)
				affixData = this.readFile(path + '/' + language + '/' + language + '.aff');
			if(!dictionaryData)
				dictionaryData = this.readFile(path + '/' + language + '/' + language + '.dic');
		}

		this.rules = this.parseAFF(affixData);

		//save the rule codes that are used in compound rules
		this.compoundRuleCodes = {};

		for(var i = 0, len = this.compoundRules.length; i < len; i ++){
			var rule = this.compoundRules[i];

			for(var j = 0, jlen = rule.length; j < jlen; j ++)
				this.compoundRuleCodes[rule[j]] = [];
		}

		//if we add this ONLYINCOMPOUND flag to this.compoundRuleCodes, then parseDIC will do the work of saving the list of words that are compound-only
		if('ONLYINCOMPOUND' in this.flags)
			this.compoundRuleCodes[this.flags.ONLYINCOMPOUND] = [];

		this.dictionaryTable = this.parseDIC(dictionaryData);

		//get rid of any codes from the compound rule codes that are never used (or that were special regex characters)
		//NOTE: not especially necessary...
		for(var i in this.compoundRuleCodes)
			if(this.compoundRuleCodes[i].length == 0)
				delete this.compoundRuleCodes[i];

		//build the full regular expressions for each compound rule
		//I have a feeling (but no confirmation yet) that this method of testing for compound words is probably slow
		for(var i = 0, len = this.compoundRules.length; i < len; i ++){
			var ruleText = this.compoundRules[i];

			var expressionText = '';

			for(var j = 0, jlen = ruleText.length; j < jlen; j ++){
				var character = ruleText[j];

				if(character in this.compoundRuleCodes)
					expressionText += '(' + this.compoundRuleCodes[character].join('|') + ')';
				else
					expressionText += character;
			}

			this.compoundRules[i] = new RegExp(expressionText, 'i');
		}

		this.loaded = true;
	}

	return this;
};

Typo.prototype = {
	/**
	 * Loads a Typo instance from a hash of all of the Typo properties.
	 *
	 * @param object obj A hash of Typo properties, probably gotten from a JSON.parse(JSON.stringify(typo_instance)).
	 */
	load : function (obj){
		for(var i in obj)
			if(obj.hasOwnProperty(i))
				this[i] = obj[i];

		return this;
	},

	/**
	 * Read the contents of a file.
	 * 
	 * @param {String} path	The path (relative) to the file.
	 * @param {String} [charset="ISO8859-1"]	The expected charset of the file
	 * @returns {String}	The file data if async is false, otherwise a promise object. If running node.js, the data is always returned.
	 */
	readFile : function (path, charset){
		charset = charset || 'ISO8859-1';

		var req = new XMLHttpRequest();
		req.open('GET', path, false);

		if(req.overrideMimeType)
			req.overrideMimeType('text/plain; charset=' + charset);

		req.send(null);

		return req.responseText;
	},

	/**
	 * Parse the rules out from a .aff file.
	 *
	 * @param {String} data The contents of the affix file.
	 * @returns object The rules from the file.
	 */
	parseAFF : function (data){
		var rules = {};

		//remove comment lines
		data = this.removeAffixComments(data);

		var lines = data.split('\n');

		for(var i = 0, len = lines.length; i < len; i ++){
			var line = lines[i];

			var definitionParts = line.split(/\s+/);

			var ruleType = definitionParts[0];

			if(ruleType == 'PFX' || ruleType == 'SFX'){
				var ruleCode = definitionParts[1];
				var combineable = definitionParts[2];
				var numEntries = parseInt(definitionParts[3], 10);

				var entries = [];

				for(var j = i + 1, jlen = i + 1 + numEntries; j < jlen; j ++){
					var line = lines[j];

					var lineParts = line.split(/\s+/);
					var charactersToRemove = lineParts[2];

					var additionParts = lineParts[3].split('/');

					var charactersToAdd = additionParts[0];
					if(charactersToAdd === '0')
						charactersToAdd = '';

					var continuationClasses = this.parseRuleCodes(additionParts[1]);

					var regexToMatch = lineParts[4];

					var entry = {};
					entry.add = charactersToAdd;

					if(continuationClasses.length > 0)
						entry.continuationClasses = continuationClasses;

					if(regexToMatch !== '.'){
						if(ruleType === 'SFX')
							entry.match = new RegExp(regexToMatch + '$');
						else
							entry.match = new RegExp('^' + regexToMatch);
					}

					if(charactersToRemove != '0'){
						if(ruleType === 'SFX')
							entry.remove = new RegExp(charactersToRemove + '$');
						else
							entry.remove = charactersToRemove;
					}

					entries.push(entry);
				}

				rules[ruleCode] = {
					type: ruleType,
					combineable: (combineable == 'Y'),
					entries: entries
				};

				i += numEntries;
			}
			else if(ruleType === 'COMPOUNDRULE'){
				var numEntries = parseInt(definitionParts[1], 10);

				for(var j = i + 1, jlen = i + 1 + numEntries; j < jlen; j ++){
					var line = lines[j];

					var lineParts = line.split(/\s+/);
					this.compoundRules.push(lineParts[1]);
				}

				i += numEntries;
			}
			else if(ruleType === 'REP'){
				var lineParts = line.split(/\s+/);

				if(lineParts.length === 3)
					this.replacementTable.push([lineParts[1], lineParts[2]]);
			}
			else{
				// ONLYINCOMPOUND
				// COMPOUNDMIN
				// FLAG
				// KEEPCASE
				// NEEDAFFIX

				this.flags[ruleType] = definitionParts[1];
			}
		}

		return rules;
	},

	/**
	 * Removes comment lines and then cleans up blank lines and trailing whitespace.
	 *
	 * @param {String} data The data from an affix file.
	 * @return {String} The cleaned-up data.
	 */
	removeAffixComments : function (data){
		//remove comments
		//this used to remove any string starting with '#' up to the end of the line, but some COMPOUNDRULE definitions include '#' as part of the rule;
		//so, only remove lines that begin with a comment, optionally preceded by whitespace
		data = data.replace(/^\s*#/mg, '');

		//trim each line
		data = data.replace(/^\s\s*/m, '').replace(/\s\s*$/m, '');

		//remove blank lines
		data = data.replace(/\n{2,}/g, '\n');

		//trim the entire string
		data = data.replace(/^\s\s*/, '').replace(/\s\s*$/, '');

		return data;
	},

	/**
	 * Parses the words out from the .dic file.
	 *
	 * @param {String} data The data from the dictionary file.
	 * @returns object The lookup table containing all of the words and word forms from the dictionary.
	 */
	parseDIC : function (data){
		data = this.removeDicComments(data);

		var lines = data.split(/\r?\n/);
		var dictionaryTable = {};

		function addWord(word, rules){
			//some dictionaries will list the same word multiple times with different rule sets
			if(!dictionaryTable.hasOwnProperty(word))
				dictionaryTable[word] = null;

			if(rules.length > 0){
				if(!(word in dictionaryTable) || typeof dictionaryTable[word] != 'object')
					dictionaryTable[word] = [];

				dictionaryTable[word].push(rules);
			}
		}

		//the first line is the number of words in the dictionary
		for(var i = 1, len = lines.length; i < len; i ++){
			var line = lines[i];

			var parts = line.split('/', 2);

			var word = parts[0];

			//now for each affix rule, generate that form of the word
			if(parts.length > 1){
				var ruleCodesArray = this.parseRuleCodes(parts[1]);

				//save the ruleCodes for compound word situations
				if(!('NEEDAFFIX' in this.flags) || ruleCodesArray.indexOf(this.flags.NEEDAFFIX) == -1)
					addWord(word, ruleCodesArray);

				for(var j = 0, jlen = ruleCodesArray.length; j < jlen; j ++){
					var code = ruleCodesArray[j];

					var rule = this.rules[code];
					if(rule){
						var newWords = this.applyRule(word, rule);

						for(var ii = 0, iilen = newWords.length; ii < iilen; ii ++){
							var newWord = newWords[ii];

							addWord(newWord, []);

							if(rule.combineable){
								for(var k = j + 1; k < jlen; k ++){
									var combineCode = ruleCodesArray[k];

									var combineRule = this.rules[combineCode];

									if(combineRule && combineRule.combineable && (rule.type != combineRule.type)){
										var otherNewWords = this.applyRule(newWord, combineRule);

										for(var iii = 0, iiilen = otherNewWords.length; iii < iiilen; iii ++){
											var otherNewWord = otherNewWords[iii];
											addWord(otherNewWord, []);
										}
									}
								}
							}
						}
					}

					if(code in this.compoundRuleCodes)
						this.compoundRuleCodes[code].push(word);
				}
			}
			else
				addWord(word.trim(), []);
		}

		return dictionaryTable;
	},

	/**
	 * Removes comment lines and then cleans up blank lines and trailing whitespace.
	 *
	 * @param {String} data The data from a .dic file.
	 * @return {String} The cleaned-up data.
	 */
	removeDicComments : function (data){
		//I can't find any official documentation on it, but at least the de_DE dictionary uses tab-indented lines as comments

		//remove comments
		data = data.replace(/^\t.*$/mg, '');

		//trim each line
		data = data.replace(/^\s\s*/m, '').replace(/\s\s*$/m, '');

		//remove blank lines
		data = data.replace(/\n{2,}/g, '\n');

		//trim the entire string
		data = data.replace(/^\s\s*/, '').replace(/\s\s*$/, '');

		return data;
	},

	parseRuleCodes : function (textCodes){
		if(!textCodes)
			return [];

		if(!('FLAG' in this.flags))
			//the flag symbols are single characters
			return textCodes.split('');

		if(this.flags.FLAG === 'long'){
			//the flag symbols are two characters long
			var flags = [];

			for(var i = 0, len = textCodes.length; i < len; i += 2)
				flags.push(textCodes.substr(i, 2));

			return flags;
		}

		if(this.flags.FLAG === 'num')
			//the flag symbols are a CSV list of numbers
			return textCode.split(',');

		if(this.flags.FLAG === 'UTF-8')
			//the flags are single UTF-8 characters
			//@see https://github.com/cfinke/Typo.js/issues/57
			return Array.from(textCodes);

		//it's possible that this fallback case will not work for all FLAG values, but I think it's more likely to work than not returning anything at all
		return textCodes.split('');
	},

	/**
	 * Applies an affix rule to a word.
	 *
	 * @param {String} word The base word.
	 * @param {Object} rule The affix rule.
	 * @returns {String[]} The new words generated by the rule.
	 */
	applyRule : function (word, rule){
		var entries = rule.entries;
		var newWords = [];

		for(var i = 0, len = entries.length; i < len; i ++){
			var entry = entries[i];

			if(!entry.match || word.match(entry.match)){
				var newWord = word;

				if(entry.remove)
					newWord = newWord.replace(entry.remove, '');

				if(rule.type === 'SFX')
					newWord = newWord + entry.add;
				else
					newWord = entry.add + newWord;

				newWords.push(newWord);

				if('continuationClasses' in entry){
					for(var j = 0, jlen = entry.continuationClasses.length; j < jlen; j ++){
						var continuationRule = this.rules[entry.continuationClasses[j]];

						if(continuationRule)
							newWords = newWords.concat(this.applyRule(newWord, continuationRule));
						/*
						else{
							// This shouldn't happen, but it does, at least in the de_DE dictionary.
							// I think the author mistakenly supplied lower-case rule codes instead of upper-case.
						}
						*/
					}
				}
			}
		}

		return newWords;
	},

	/**
	 * Checks whether a word or a capitalization variant exists in the current dictionary.
	 * The word is trimmed and several variations of capitalizations are checked.
	 * If you want to check a word without any changes made to it, call checkExact()
	 *
	 * @see http://blog.stevenlevithan.com/archives/faster-trim-javascript re:trimming function
	 *
	 * @param {String} aWord The word to check.
	 * @returns {Boolean}
	 */
	check : function (aWord){
		if(!this.loaded)
			throw "Dictionary not loaded.";

		//remove leading and trailing whitespace
		var trimmedWord = aWord.replace(/^\s\s*/, '').replace(/\s\s*$/, '');

		if(this.checkExact(trimmedWord))
			return true;

		//the exact word is not in the dictionary
		if(trimmedWord.toUpperCase() === trimmedWord){
			//the word was supplied in all uppercase
			//check for a capitalized form of the word
			var capitalizedWord = trimmedWord[0] + trimmedWord.substring(1).toLowerCase();

			if(this.hasFlag(capitalizedWord, 'KEEPCASE'))
				//capitalization variants are not allowed for this word.
				return false;

			if(this.checkExact(capitalizedWord))
				//the all-caps word is a capitalized word spelled correctly
				return true;

			if(this.checkExact(trimmedWord.toLowerCase()))
				//the all-caps is a lowercase word spelled correctly
				return true;
		}

		var uncapitalized = trimmedWord[0].toLowerCase() + trimmedWord.substring(1);

		if(uncapitalized !== trimmedWord){
			if(this.hasFlag(uncapitalized, 'KEEPCASE'))
				//capitalization variants are not allowed for this word
				return false;

			//check for an uncapitalized form
			if(this.checkExact(uncapitalized))
				//the word is spelled correctly but with the first letter capitalized
				return true;
		}

		return false;
	},

	/**
	 * Checks whether a word exists in the current dictionary.
	 *
	 * @param {String} word The word to check.
	 * @returns {Boolean}
	 */
	checkExact : function (word){
		if(!this.loaded)
			throw "Dictionary not loaded.";

		var ruleCodes = this.dictionaryTable[word];

		if(typeof ruleCodes === 'undefined'){
			//check if this might be a compound word
			if('COMPOUNDMIN' in this.flags && word.length >= this.flags.COMPOUNDMIN)
				for(var i = 0, len = this.compoundRules.length; i < len; i ++)
					if(word.match(this.compoundRules[i]))
						return true;

			return false;
		}

		if(ruleCodes === null)
			//a null (but not undefined) value for an entry in the dictionary table means that the word is in the dictionary but has no flags
			return true;

		// this.dictionary['hasOwnProperty'] will be a function.
		if(typeof ruleCodes === 'object')
			for(var i = 0, len = ruleCodes.length; i < len; i ++)
				if(!this.hasFlag(word, 'ONLYINCOMPOUND', ruleCodes[i]))
					return true;

		return false;
	},

	/**
	 * Looks up whether a given word is flagged with a given flag.
	 *
	 * @param {String} word The word in question.
	 * @param {String} flag The flag in question.
	 * @return {Boolean}
	 */
	hasFlag : function (word, flag, wordFlags){
		if(!this.loaded)
			throw "Dictionary not loaded.";

		if(flag in this.flags){
			if(typeof wordFlags === 'undefined')
				var wordFlags = Array.prototype.concat.apply([], this.dictionaryTable[word]);

			if(wordFlags && wordFlags.indexOf(this.flags[flag]) !== -1)
				return true;
		}

		return false;
	},

	/**
	 * Returns a list of suggestions for a misspelled word.
	 *
	 * @see http://www.norvig.com/spell-correct.html for the basis of this suggestor.
	 * This suggestor is primitive, but it works.
	 *
	 * @param {String} word The misspelling.
	 * @param {Number} [limit=5] The maximum number of suggestions to return.
	 * @returns {String[]} The array of suggestions.
	 */

	alphabet : '',

	suggest : function (word, limit){
		if(!this.loaded)
			throw "Dictionary not loaded.";

		limit = limit || 5;

		if(this.memoized.hasOwnProperty(word)){
			var memoizedLimit = this.memoized[word]['limit'];

			//only return the cached list if it's big enough or if there weren't enough suggestions to fill a smaller limit
			if(limit <= memoizedLimit || this.memoized[word]['suggestions'].length < memoizedLimit)
				return this.memoized[word]['suggestions'].slice(0, limit);
		}

		if(this.check(word))
			return [];

		//check the replacement table
		for(var i = 0, len = this.replacementTable.length; i < len; i ++){
			var replacementEntry = this.replacementTable[i];

			if(word.indexOf(replacementEntry[0]) !== -1){
				var correctedWord = word.replace(replacementEntry[0], replacementEntry[1]);

				if(this.check(correctedWord))
					return [correctedWord];
			}
		}

		var self = this;
		self.alphabet = 'abcdefghijklmnopqrstuvwxyz';

		/*
		if(!self.alphabet){
			//use the alphabet as implicitly defined by the words in the dictionary
			var alphaHash = {};

			for(var i in self.dictionaryTable)
				for(var j = 0, len = i.length; j < len; j ++)
					alphaHash[i[j]] = true;

			for(var i in alphaHash)
				self.alphabet += i;

			var alphaArray = self.alphabet.split('');
			alphaArray.sort();
			self.alphabet = alphaArray.join('');
		}
		*/

		/**
		 * Returns a hash keyed by all of the strings that can be made by making a single edit to the word (or words in) `words`
		 * The value of each entry is the number of unique ways that the resulting word can be made.
		 *
		 * @arg mixed words Either a hash keyed by words or a string word to operate on.
		 * @arg bool known_only Whether this function should ignore strings that are not in the dictionary.
		 */
		function edits1(words, known_only){
			var rv = [];

			for(var ii = 0, iilen = words.length; ii < iilen; ii ++){
				var word = words[ii];

				var splits = [];
				for(var i = 0, len = word.length + 1; i < len; i ++)
					splits.push([word.substring(0, i), word.substring(i, word.length)]);

				//remove a letter
				var deletes = [];
				for(var i = 0, len = splits.length; i < len; i ++){
					var s = splits[i];
					if(s[1])
						deletes.push(s[0] + s[1].substring(1));
				}

				//transpose letters
				//eliminate transpositions of identical letters
				var transposes = [];
				for(var i = 0, len = splits.length; i < len; i ++){
					var s = splits[i];
					if(s[1].length > 1 && s[1][1] !== s[1][0])
						transposes.push(s[0] + s[1][1] + s[1][0] + s[1].substring(2));
				}

				var replaces = [];
				for(var i = 0, len = splits.length; i < len; i ++){
					var s = splits[i];
					if(s[1])
						for(var j = 0, jlen = self.alphabet.length; j < jlen; j ++)
							replaces.push(s[0] + self.alphabet[j] + s[1].substring(1));
				}

				var inserts = [];
				for(var i = 0, len = splits.length; i < len; i ++){
					var s = splits[i];
					if(s[1])
						for(var j = 0, jlen = self.alphabet.length; j < jlen; j ++)
							replaces.push(s[0] + self.alphabet[j] + s[1]);
				}

				rv = rv.concat(deletes);
				rv = rv.concat(transposes);
				rv = rv.concat(replaces);
				rv = rv.concat(inserts);
			}

			return rv;
		}

		function known(words){
			var rv = [];
			for(var i = 0; i < words.length; i ++)
				if(self.check(words[i]))
					rv.push(words[i]);
			return rv;
		}

		function correct(word){
			//get the edit-distance-1 and edit-distance-2 forms of this word
			var ed1 = edits1([word]);
			var ed2 = edits1(ed1, true);

			var corrections = known(ed1).concat(known(ed2));

			//sort the edits based on how many different ways they were created
			var weighted_corrections = {};

			for(var i = 0, len = corrections.length; i < len; i ++){
				if(!(corrections[i] in weighted_corrections))
					weighted_corrections[corrections[i]] = 1;
				else
					weighted_corrections[corrections[i]] += 1;
			}

			var sorted_corrections = [];
			for(var i in weighted_corrections)
				if(weighted_corrections.hasOwnProperty(i))
					sorted_corrections.push([i, weighted_corrections[i]]);

			function sorter(a, b){
				var a_val = a[1];
				var b_val = b[1];
				if(a_val < b_val)
					return -1;
				if (a_val > b_val)
					return 1;
				return b[0].localeCompare(a[0]);
			}

			sorted_corrections.sort(sorter).reverse();

			var rv = [];

			var capitalization_scheme = 'lowercase';
			if(word.toUpperCase() === word)
				capitalization_scheme = 'uppercase';
			else if (word.substr(0, 1).toUpperCase() + word.substr(1).toLowerCase() === word)
				capitalization_scheme = 'capitalized';

			for(var i = 0, len = Math.min(limit, sortedcorrections.length); i < len; i ++){
				if('uppercase' === capitalization_scheme)
					sorted_corrections[i][0] = sorted_corrections[i][0].toUpperCase();
				else if('capitalized' === capitalization_scheme)
					sorted_corrections[i][0] = sorted_corrections[i][0].substr(0, 1).toUpperCase() + sorted_corrections[i][0].substr(1);
				
				if(!self.hasFlag(sorted_corrections[i][0], 'NOSUGGEST') && rv.indexOf(sorted_corrections[i][0]) == -1)
					rv.push(sorted_corrections[i][0]);
				else
					//if one of the corrections is not eligible as a suggestion , make sure we still return the right number of suggestions
					limit ++;
			}

			return rv;
		}

		this.memoized[word] = {
			'suggestions': correct(word),
			'limit': limit
		};

		return this.memoized[word]['suggestions'];
	}
};
