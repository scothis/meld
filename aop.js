/**
 * @license Copyright (c) 2011 Brian Cavalier
 * LICENSE: see the LICENSE.txt file. If file is missing, this file is subject
 * to the MIT License at: http://www.opensource.org/licenses/mit-license.php.
 */

// Begin AMD/Node/browser boilerplate
(typeof define == "function" ? define : function (factory) { typeof module != 'undefined' ? (module.exports = factory()) : (this.aop = factory()); })(function() {
// End boilerplate

	var VERSION, ap, prepend, append, slice, isArray, freeze;

	VERSION = "0.5.0";

    freeze = Object.freeze || function() {};

	ap      = Array.prototype;
	prepend = ap.unshift;
	append  = ap.push;
	slice   = ap.slice;

	isArray = Array.isArray || function(it) {
		return Object.prototype.toString.call(it) == '[object Array]';
	};

	// Helper to convert arguments to an array
	function argsToArray(a) {
		return slice.call(a);
	}

	function forEach(array, func) {
        for(var i=0, len=array.length; i<len; ++i) {
            func(array[i]);
        }
	}

	function forEachReverse(array, func) {
        for(var i=array.length-1; i>=0; --i) {
            func(array[i]);
        }
	}

    var iterators = {
        // Before uses reverse iteration
        before: forEachReverse
    };

    // All other advice types use forward iteration
    // Around is a special case that uses recursion rather than
    // iteration.  See Advisor._callAroundAdvice
    iterators.on
        = iterators.afterReturning
        = iterators.afterThrowing
        = iterators.after
        = forEach;

    function proceedAlreadyCalled() { throw new Error("proceed() may only be called once"); }

	function Advisor(target, func) {

		var orig, advisor;

		this.target = target;
		this.func = func;
        this.aspects = [];

		orig = this.orig = target[func];
		advisor = this;

		this.advised = function() {
			var context, args, result, afterType, exception;

            context = this;

			function callOrig(args) {
				var result = orig.apply(context, args);
				advisor._callSimpleAdvice('on', context, args);

				return result;
			}

			function callAfter(afterType, args) {
				advisor._callSimpleAdvice(afterType, context, args);
			}

			args = argsToArray(arguments);
			afterType = 'afterReturning';

			advisor._callSimpleAdvice('before', context, args);

			try {
				result = advisor._callAroundAdvice(context, func, args, callOrig);
			} catch(e) {
				result = exception = e;
                // Switch to afterThrowing
				afterType = 'afterThrowing';
            }

			args = [result];

			callAfter(afterType, args);
			callAfter('after', args);

			if(exception) {
				throw exception;
			}

			return result;
		};

		this.advised._advisor = this;
	}

	Advisor.prototype = {

        /**
         * Invoke all advice functions in the supplied context, with the supplied args
         *
         * @param adviceType
         * @param context
         * @param args
         */
		_callSimpleAdvice: function(adviceType, context, args) {

			// before advice runs LIFO, from most-recently added to least-recently added.
			// All other advice is FIFO
			var iterator = iterators[adviceType];

            iterator(this.aspects, function(aspect) {
                var advice = aspect[adviceType];
                advice && advice.apply(context, args);
            });
		},

        /**
         * Invoke all around advice and then the original method
         *
         * @param context
         * @param method
         * @param args
         * @param orig
         */
        _callAroundAdvice: function(context, method, args, orig) {
            var len, aspects;

            aspects = this.aspects;
            len = aspects.length;

            // Call the next function in the around chain, which will either be
            // another around advice, or the orig method
            function callNext(i, args) {
                var aspect;
                // Skip to next aspect that has around advice
                while(i >= 0 && (aspect = aspects[i]) && typeof aspect.around !== 'function') --i;

                // If we exhausted all aspects, finally call the original
                // Otherwise, if we found another around, call it
                return (i < 0) ? orig.call(context, args) : callAround(aspect.around, i, args);
            }

            function callAround(around, i, args) {
                var proceed, joinpoint;

                // Create proceed function that calls the next around advice, or
                // the original.  Overwrites itself so that it can only be called
                // once.
                proceed = function(args) {
                    proceed = proceedAlreadyCalled;
                    return callNext(i-1, args);
                };

                joinpoint = {
                    target: context,
                    method: method,
                    args: args,
                    proceed: function(/* newArgs */) {
                        // if new arguments were provided, use them
                        return proceed(arguments.length > 0 ? argsToArray(arguments) : args);
                    }
                };

                // Joinpoint is immutable
                freeze(joinpoint);

                // Call supplied around advice function
                return around.call(context, joinpoint);
            }

            return callNext(len-1, args);
        },

        /**
         * Adds the supplied aspect to the advised target method
         *
         * @param aspect
         */
		add: function(aspect) {
            
			var aspects = this.aspects;

            aspects.push(aspect);

            return {
                remove: function() {
                    for (var i = aspects.length; i >= 0; --i) {
                        if (aspects[i] === aspect) {
                            aspects.splice(i, 1);
                        }
                    }
                }
            };
		},

        /**
         * Removes the Advisor and thus, all aspects from the advised target method.
         */
		remove: function() {
			this.target[this.func]._advisor = null;
			this.target[this.func] = this.orig;
		}
	};

	// Returns the advisor for the target object-function pair.  A new advisor
	// will be created if one does not already exist.
	Advisor.get = function(target, func) {
		if(!(func in target)) return;

		var advisor, advised;

		advised = target[func];

		if(typeof advised !== 'function') throw new Error('Advice can only be applied to functions: ' + func);

		advisor = advised._advisor;
		if(!advisor) {
			advisor = new Advisor(target, func);
			target[func] = advisor.advised;
		}

		return advisor;
	};

	function addAspectToMethod(target, method, aspect) {
		var advisor = Advisor.get(target, method);

		if(advisor) {
			return advisor.add(aspect);
		} else {
			throw new Error('Target does not have method: ' + method);
		}
	}

	function addAspectToAll(target, methodArray, aspect) {
		var removers, f, i;

		removers = [];
		i = 0;
		while((f = methodArray[i++])) {
			removers.push(addAspectToMethod(target, f, aspect));
		}

		return {
            remove: function() {
                for (var i = removers.length - 1; i >= 0; i--) {
                    removers[i]();
                }
            }
        };
    }

	function addAspect(target, pointcut, aspect) {
		// pointcut can be: string, Array of strings, RegExp, Function(targetObject): Array of strings
		// advice can be: object, Function(targetObject, targetMethodName)

		var pointcutType, remove;

        target = findTarget(target);

		if (isArray(pointcut)) {
			remove = addAspectToAll(target, pointcut, aspect);

		} else {
			pointcutType = typeof pointcut;

			if (pointcutType === 'string') {
				if (typeof target[pointcut] === 'function') {
					remove = addAspectToMethod(target, pointcut, aspect);
				}

			} else if (pointcutType === 'function') {
				remove = addAspectToAll(target, pointcut(target), aspect);

			} else {
				// Assume the pointcut is a RegExp
				for (var p in target) {
					// TODO: Decide whether hasOwnProperty is correct here
					// Only apply to own properties that are functions, and match the pointcut regexp
					if (typeof target[p] === 'function' && pointcut.test(p)) {
						// if(object.hasOwnProperty(p) && typeof object[p] === 'function' && pointcut.test(p)) {
						remove = addAspectToMethod(target, p, aspect);

					}
				}

			}
		}

		return remove;

	}
	
    function findTarget(target) {
        return target.prototype || target;
    }

	// Create an API function for the specified advice type
	function adviceApi(type) {
		return function(target, func, adviceFunc) {
			var aspect = {};
			aspect[type] = adviceFunc;
			
			return addAspect(target, func, aspect);
		};
	}

	// Public API
	return {
		// General add aspect
		// Returns a function that will remove the newly-added aspect
		add:            addAspect,

		// Add a single, specific type of advice
		// returns a function that will remove the newly-added advice
		before:         adviceApi('before'),
		around:         adviceApi('around'),
		on:             adviceApi('on'),
		afterReturning: adviceApi('afterReturning'),
		afterThrowing:  adviceApi('afterThrowing'),
		after:          adviceApi('after')
	};

});
