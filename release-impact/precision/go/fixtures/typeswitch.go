package main

func typeSwitch(v interface{}) int {
	n := 0
	switch t := v.(type) {
	case int:
		n = t
	case int64:
		n = int(t)
	default:
		n = -1
	}
	return n
}
